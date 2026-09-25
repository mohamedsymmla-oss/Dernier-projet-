import { describe, expect, it } from 'vitest';
import { analyzePhoneList, normalizePhone, splitPhoneList, maskPhone } from '../src/index.js';

describe('normalizePhone', () => {
  it('normalise avec espaces, tirets et parenthèses', () => {
    expect(normalizePhone('+223 76 12-34 (56)')).toMatchObject({ ok: true, e164: '+22376123456' });
  });
  it('convertit 00 en +', () => {
    expect(normalizePhone('0022376123456')).toMatchObject({ ok: true, e164: '+22376123456' });
  });
  it('utilise le pays par défaut pour un numéro local', () => {
    expect(normalizePhone('76 12 34 56', 'ML')).toMatchObject({ ok: true, e164: '+22376123456' });
    expect(normalizePhone('06 12 34 56 78', 'FR')).toMatchObject({ ok: true, e164: '+33612345678' });
  });
  it("accepte un numéro international sans + si valide", () => {
    expect(normalizePhone('22376123456', 'FR')).toMatchObject({ ok: true, e164: '+22376123456' });
    expect(normalizePhone('22376123456')).toMatchObject({ ok: true, e164: '+22376123456' });
  });
  it('rejette avec une raison explicite', () => {
    expect(normalizePhone('')).toMatchObject({ ok: false, reason: 'VIDE' });
    expect(normalizePhone('abc123')).toMatchObject({ ok: false, reason: 'CARACTERES_INVALIDES' });
    expect(normalizePhone('+223 12')).toMatchObject({ ok: false, reason: 'NUMERO_INVALIDE' });
    expect(normalizePhone('761234')).toMatchObject({ ok: false });
  });
  it('masque les numéros', () => {
    expect(maskPhone('+22376123456')).toBe('+22376****56');
  });
});

describe('analyzePhoneList', () => {
  it('détecte doublons, invalides et lignes vides sans rien supprimer', () => {
    const content = ['+223 76 12 34 56', '', '+22376123456', 'bonjour', '0022365432198', '76-12-34-56'].join('\n');
    const res = analyzePhoneList(content, 'paste', 'ML');
    expect(res).toHaveLength(6);
    expect(res.map((r) => r.status)).toEqual(['VALID', 'EMPTY', 'DUPLICATE_IN_LIST', 'INVALID', 'VALID', 'DUPLICATE_IN_LIST']);
    expect(res[2]!.reason).toContain('ligne 1');
  });
  it('gère un CSV avec en-tête et guillemets', () => {
    const csv = 'nom;telephone\n"Awa";"+223 76 12 34 56"\nMoussa;65432198\n';
    const lines = splitPhoneList(csv, 'csv');
    expect(lines.map((l) => l.raw)).toEqual(['+223 76 12 34 56', '65432198', '']);
    const res = analyzePhoneList(csv, 'csv', 'ML');
    expect(res.filter((r) => r.status === 'VALID').map((r) => r.e164)).toEqual(['+22376123456', '+22365432198']);
  });
  it('supporte plusieurs milliers de numéros', () => {
    const nums = Array.from({ length: 5000 }, (_, i) => `+2237${String(6000000 + i).padStart(7, '0')}`);
    const res = analyzePhoneList(nums.join('\n'), 'paste');
    expect(res.filter((r) => r.status === 'VALID')).toHaveLength(5000);
  });
});
