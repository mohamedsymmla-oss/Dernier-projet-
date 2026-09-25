import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

export type PhoneRejectReason =
  | 'VIDE'
  | 'CARACTERES_INVALIDES'
  | 'INDICATIF_MANQUANT'
  | 'NUMERO_INVALIDE';

export const PHONE_REJECT_LABELS: Record<PhoneRejectReason, string> = {
  VIDE: 'Ligne vide',
  CARACTERES_INVALIDES: 'Contient des lettres ou caractères non autorisés',
  INDICATIF_MANQUANT: "Pas d'indicatif pays et aucun pays par défaut défini",
  NUMERO_INVALIDE: "Numéro invalide pour le pays détecté (longueur ou format)",
};

export type NormalizeResult =
  | { ok: true; e164: string; country?: string }
  | { ok: false; reason: PhoneRejectReason; label: string };

/**
 * Normalise un numéro au format E.164 (+XXXXXXXX).
 * Supprime espaces, tirets, points, parenthèses. Convertit le préfixe 00 en +.
 * Sans indicatif, utilise defaultCountry (ex: 'ML' pour +223).
 */
export function normalizePhone(raw: string, defaultCountry?: string): NormalizeResult {
  const trimmed = (raw ?? '').replace(/^﻿/, '').trim();
  if (trimmed === '') return fail('VIDE');

  // Retirer séparateurs usuels
  let cleaned = trimmed.replace(/[\s\-.()/ ‑‒–—]/g, '');
  if (cleaned.startsWith('00')) cleaned = '+' + cleaned.slice(2);
  if (!/^\+?\d+$/.test(cleaned)) return fail('CARACTERES_INVALIDES');

  const hasPlus = cleaned.startsWith('+');
  if (!hasPlus && !defaultCountry) {
    // Tentative : le numéro contient peut-être déjà l'indicatif sans le +
    const guess = parsePhoneNumberFromString('+' + cleaned);
    if (guess && guess.isValid()) return { ok: true, e164: guess.number, country: guess.country };
    return fail('INDICATIF_MANQUANT');
  }

  let parsed = hasPlus
    ? parsePhoneNumberFromString(cleaned)
    : parsePhoneNumberFromString(cleaned, defaultCountry!.toUpperCase() as CountryCode);

  // Numéro saisi sans + mais incluant déjà l'indicatif international (ex: 22376...)
  if ((!parsed || !parsed.isValid()) && !hasPlus) {
    const alt = parsePhoneNumberFromString('+' + cleaned);
    if (alt && alt.isValid()) parsed = alt;
  }

  if (!parsed || !parsed.isValid()) return fail('NUMERO_INVALIDE');
  return { ok: true, e164: parsed.number, country: parsed.country };
}

function fail(reason: PhoneRejectReason): NormalizeResult {
  return { ok: false, reason, label: PHONE_REJECT_LABELS[reason] };
}

export function isE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value);
}

/** Masque un numéro pour les logs : +22376****89 */
export function maskPhone(e164: string): string {
  if (e164.length <= 6) return '***';
  return e164.slice(0, 6) + '*'.repeat(Math.max(3, e164.length - 8)) + e164.slice(-2);
}

export interface ParsedListLine {
  line: number;
  raw: string;
}

/**
 * Découpe un contenu collé / TXT / CSV en valeurs candidates, ligne par ligne.
 * Pour CSV : prend la colonne dont l'en-tête ressemble à phone/numéro/tel,
 * sinon la première colonne contenant des chiffres.
 */
export function splitPhoneList(content: string, format: 'paste' | 'txt' | 'csv'): ParsedListLine[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (format !== 'csv') {
    const out: ParsedListLine[] = [];
    lines.forEach((l, i) => {
      // Une ligne collée peut contenir plusieurs numéros séparés par , ou ;
      const parts = l.split(/[;,\t]/);
      for (const p of parts) out.push({ line: i + 1, raw: p });
    });
    return out;
  }
  const delimiter = detectDelimiter(lines[0] ?? '');
  const header = splitCsvLine(lines[0] ?? '', delimiter).map((h) => h.trim().toLowerCase());
  let col = header.findIndex((h) => /(phone|t[ée]l|num[ée]ro|mobile|whatsapp|contact)/.test(h));
  let start = 1;
  if (col === -1) {
    // Pas d'en-tête reconnu : la première ligne est une donnée
    start = 0;
    const first = splitCsvLine(lines[0] ?? '', delimiter);
    col = Math.max(0, first.findIndex((c) => /\d{5,}/.test(c)));
  }
  const out: ParsedListLine[] = [];
  for (let i = start; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i] ?? '', delimiter);
    out.push({ line: i + 1, raw: cells[col] ?? '' });
  }
  return out;
}

function detectDelimiter(line: string): string {
  const counts = [',', ';', '\t'].map((d) => [d, line.split(d).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 1 ? counts[0]![0] : ',';
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

export type ImportLineStatus = 'VALID' | 'INVALID' | 'DUPLICATE_IN_LIST' | 'EMPTY';

export interface AnalyzedLine {
  line: number;
  raw: string;
  status: ImportLineStatus;
  e164?: string;
  reason?: string;
}

/** Analyse une liste : valide / invalide / doublon (dans la liste) / vide. Aucune ligne n'est supprimée silencieusement. */
export function analyzePhoneList(
  content: string,
  format: 'paste' | 'txt' | 'csv',
  defaultCountry?: string,
): AnalyzedLine[] {
  const seen = new Map<string, number>();
  const result: AnalyzedLine[] = [];
  for (const { line, raw } of splitPhoneList(content, format)) {
    const n = normalizePhone(raw, defaultCountry);
    if (!n.ok) {
      if (n.reason === 'VIDE') {
        result.push({ line, raw, status: 'EMPTY', reason: n.label });
      } else {
        result.push({ line, raw, status: 'INVALID', reason: n.label });
      }
      continue;
    }
    const firstLine = seen.get(n.e164);
    if (firstLine !== undefined) {
      result.push({ line, raw, status: 'DUPLICATE_IN_LIST', e164: n.e164, reason: `Doublon de la ligne ${firstLine}` });
      continue;
    }
    seen.set(n.e164, line);
    result.push({ line, raw, status: 'VALID', e164: n.e164 });
  }
  return result;
}
