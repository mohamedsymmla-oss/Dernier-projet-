import { describe, expect, it } from 'vitest';
import {
  SendZenConnector,
  classifyHttpError,
  parseSendZenWebhook,
  signSendZenPayload,
  verifySendZenSignature,
  type HttpCallRecord,
} from '../src/index.js';

const sender = { phoneNumber: '+22370000000', phoneNumberId: 'pn1', wabaId: 'w1' };

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { fn, calls };
}

describe('SendZen payloads (format confirmé nœud n8n / SDK)', () => {
  it('texte', () => {
    expect(SendZenConnector.buildMessageBody(sender, '+22376123456', { kind: 'text', body: 'Bonjour' })).toEqual({
      from: '+22370000000',
      to: '+22376123456',
      type: 'text',
      text: { body: 'Bonjour', preview_url: false },
    });
  });
  it('audio standard sans paramètre PTT inventé', () => {
    const b = SendZenConnector.buildMessageBody(sender, '+22376123456', { kind: 'audio', media: { link: 'https://x/a.ogg' } });
    expect(b).toEqual({ from: '+22370000000', to: '+22376123456', type: 'audio', audio: { link: 'https://x/a.ogg' } });
    expect(JSON.stringify(b)).not.toContain('voice');
  });
  it('image', () => {
    expect(SendZenConnector.buildMessageBody(sender, '+1', { kind: 'image', media: { link: 'https://x/p.jpg' } })).toMatchObject({
      type: 'image',
      image: { link: 'https://x/p.jpg' },
    });
  });
  it('template', () => {
    expect(
      SendZenConnector.buildMessageBody(sender, '+1', { kind: 'template', name: 'relance', languageCode: 'fr' }),
    ).toMatchObject({ type: 'template', template: { name: 'relance', lang_code: 'fr', components: [] } });
  });
  it('PTT refusé explicitement', async () => {
    const c = new SendZenConnector({ apiKey: 'k' }, { fetchImpl: mockFetch(200, {}).fn });
    await expect(c.send(sender, '+1', { kind: 'audio', media: { link: 'x' }, asVoiceNote: true })).rejects.toMatchObject({
      kind: 'NOT_AVAILABLE',
    });
    expect(c.capabilities().sendVoiceNote.status).toBe('NOT_AVAILABLE');
  });
});

describe('SendZen HTTP', () => {
  it('envoie avec Bearer et extrait message_id ; journal sans secret', async () => {
    const m = mockFetch(202, { message: 'ok', data: [{ message_id: 'wamid.1', status: 'queued', to: '+1' }] }, { 'x-request-id': 'r1' });
    const logs: HttpCallRecord[] = [];
    const c = new SendZenConnector({ apiKey: 'sk_live_secret' }, { fetchImpl: m.fn, observer: (r) => void logs.push(r) });
    const res = await c.send(sender, '+22376123456', { kind: 'text', body: 'hi' });
    expect(res).toMatchObject({ providerMessageId: 'wamid.1', providerStatus: 'queued', httpStatus: 202, requestId: 'r1' });
    expect(m.calls[0]!.url).toBe('https://api.sendzen.io/v1/messages');
    expect((m.calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk_live_secret');
    expect(logs[0]).toMatchObject({ endpoint: '/v1/messages', httpStatus: 202, providerMessageId: 'wamid.1' });
    expect(JSON.stringify(logs)).not.toContain('sk_live_secret');
  });
  it('testAuth utilise /v1/auth/api_key', async () => {
    const m = mockFetch(401, { message: 'Unauthorized', error: { code: 'UNAUTHORIZED', details: 'Invalid API key' } });
    const c = new SendZenConnector({ apiKey: 'bad' }, { fetchImpl: m.fn });
    const r = await c.testAuth();
    expect(m.calls[0]!.url).toBe('https://api.sendzen.io/v1/auth/api_key');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('AUTH');
  });
  it('liste projets / WABA / numéros', async () => {
    const m = mockFetch(200, {
      message: 'ok',
      data: {
        projects: [
          {
            id: 7,
            project_name: 'Boutique',
            wabas: [{ waba_id: '123', waba_business_name: 'Shop', phone_number_id: '999', phone_number: '223 70 00 00 00', number_status: 'CONNECTED' }],
          },
        ],
      },
    });
    const c = new SendZenConnector({ apiKey: 'k' }, { fetchImpl: m.fn });
    const nums = await c.getPhoneNumbers();
    expect(nums[0]).toMatchObject({ projectName: 'Boutique', wabaId: '123', phoneNumberId: '999', phoneNumber: '+22370000000', isConnected: true });
  });
  it('429 → RATE_LIMITED avec Retry-After', async () => {
    const m = mockFetch(429, { message: 'Too many' }, { 'retry-after': '3' });
    const c = new SendZenConnector({ apiKey: 'k' }, { fetchImpl: m.fn });
    await expect(c.send(sender, '+1', { kind: 'text', body: 'x' })).rejects.toMatchObject({ kind: 'RATE_LIMITED', details: { retryAfterMs: 3000 } });
  });
  it('timeout → TRANSIENT', async () => {
    const c = new SendZenConnector(
      { apiKey: 'k' },
      {
        timeoutMs: 20,
        fetchImpl: (_u, init) =>
          new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
      },
    );
    await expect(c.send(sender, '+1', { kind: 'text', body: 'x' })).rejects.toMatchObject({ kind: 'TRANSIENT' });
  });
  it('réponse 2xx sans message_id → non confirmé', async () => {
    const c = new SendZenConnector({ apiKey: 'k' }, { fetchImpl: mockFetch(200, { message: 'ok' }).fn });
    await expect(c.send(sender, '+1', { kind: 'text', body: 'x' })).rejects.toMatchObject({ kind: 'PERMANENT' });
  });
  it('logs non disponibles tant que non confirmés', async () => {
    const c = new SendZenConnector({ apiKey: 'k' }, { fetchImpl: mockFetch(200, {}).fn });
    await expect(c.fetchLogs({ since: new Date() })).rejects.toMatchObject({ kind: 'NOT_AVAILABLE' });
  });
});

describe('classification des erreurs', () => {
  it.each([
    [500, {}, 'x', 'TRANSIENT'],
    [503, {}, 'x', 'TRANSIENT'],
    [401, {}, 'x', 'AUTH'],
    [400, { error: { code: '131047', details: 'Re-engagement message' } }, 'Re-engagement', 'WINDOW_CLOSED'],
    [400, { error: { code: '131026' } }, 'x', 'INVALID_RECIPIENT'],
    [400, { error: { code: '131053' } }, 'x', 'INVALID_MEDIA'],
    [400, {}, 'Invalid media url', 'INVALID_MEDIA'],
    [400, {}, 'something bad', 'PERMANENT'],
  ])('%s %j → %s', (status, json, msg, kind) => {
    expect(classifyHttpError(status as number, json, msg as string, null, null).kind).toBe(kind);
  });
});

describe('webhook SendZen', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'w1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '22370000000', phone_number_id: 'pn1' },
              messages: [{ from: '22376123456', id: 'wamid.IN1', timestamp: '1700000000', type: 'text', text: { body: 'Oui merci' } }],
              statuses: [
                { id: 'wamid.OUT1', status: 'delivered', timestamp: '1700000001', recipient_id: '22376123456' },
                { id: 'wamid.OUT2', status: 'failed', timestamp: '1700000002', recipient_id: '22376123456', errors: [{ code: 131047, title: 'Re-engagement message' }] },
              ],
            },
          },
        ],
      },
    ],
  };
  const raw = Buffer.from(JSON.stringify(payload));

  it('vérifie la signature HMAC', () => {
    const sig = signSendZenPayload(raw, 's3cret');
    expect(verifySendZenSignature({ rawBody: raw, headers: { 'x-hub-signature-256': sig } }, 's3cret')).toMatchObject({ verified: true });
    expect(verifySendZenSignature({ rawBody: raw, headers: { 'x-hub-signature-256': sig } }, 'autre')).toMatchObject({ verified: false });
    expect(verifySendZenSignature({ rawBody: Buffer.from('{}'), headers: { 'x-hub-signature-256': sig } }, 's3cret')).toMatchObject({ verified: false });
    expect(verifySendZenSignature({ rawBody: raw, headers: {} }, 's3cret')).toMatchObject({ verified: false, signaturePresent: false });
  });

  it('normalise messages entrants et statuts avec clés anti-doublon stables', () => {
    const ev = parseSendZenWebhook(payload, raw);
    expect(ev).toHaveLength(3);
    expect(ev[0]).toMatchObject({ type: 'inbound_message', from: '+22376123456', providerMessageId: 'wamid.IN1', text: 'Oui merci', dedupeKey: 'sendzen:in:wamid.IN1' });
    expect(ev[1]).toMatchObject({ type: 'message_status', status: 'DELIVERED', dedupeKey: 'sendzen:st:wamid.OUT1:DELIVERED' });
    expect(ev[2]).toMatchObject({ type: 'message_status', status: 'FAILED', errorCode: '131047' });
    // Même payload reçu deux fois → mêmes clés
    expect(parseSendZenWebhook(payload, raw).map((e) => e.dedupeKey)).toEqual(ev.map((e) => e.dedupeKey));
  });

  it('conserve un payload inconnu comme événement "other"', () => {
    const r = Buffer.from('{"event":"account_update"}');
    const ev = parseSendZenWebhook(JSON.parse(r.toString()), r);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'other', name: 'account_update' });
  });
});
