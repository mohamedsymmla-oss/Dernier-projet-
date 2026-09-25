import 'package:intl/intl.dart';

String fmtDelay(int seconds) {
  final m = seconds ~/ 60;
  final s = seconds % 60;
  return '${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
}

String fmtDurationMs(num? ms) {
  if (ms == null) return '—';
  final total = (ms / 1000).round();
  return '${total ~/ 60}:${(total % 60).toString().padLeft(2, '0')}';
}

String fmtBytes(num? bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return '$bytes o';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(0)} Ko';
  return '${(bytes / 1024 / 1024).toStringAsFixed(2)} Mo';
}

DateTime? parseDate(dynamic v) => v == null ? null : DateTime.tryParse('$v')?.toLocal();

String fmtDateTime(dynamic v) {
  final d = parseDate(v);
  return d == null ? '—' : DateFormat('dd/MM/yyyy HH:mm:ss', 'fr_FR').format(d);
}

String fmtTime(dynamic v) {
  final d = parseDate(v);
  return d == null ? '—' : DateFormat('HH:mm:ss', 'fr_FR').format(d);
}

String fmtDate(dynamic v) {
  final d = parseDate(v);
  return d == null ? '—' : DateFormat('dd/MM/yyyy', 'fr_FR').format(d);
}

String fmtAgo(dynamic v) {
  final d = parseDate(v);
  if (d == null) return 'jamais';
  final diff = DateTime.now().difference(d);
  if (diff.inSeconds < 60) return 'il y a ${diff.inSeconds} s';
  if (diff.inMinutes < 60) return 'il y a ${diff.inMinutes} min';
  if (diff.inHours < 48) return 'il y a ${diff.inHours} h';
  return 'le ${fmtDate(v)}';
}

const recipientStatusLabels = {
  'PENDING': 'En attente',
  'IN_PROGRESS': 'En cours',
  'COMPLETED': 'Terminé',
  'FAILED': 'Échec',
  'TEMPLATE_REQUIRED': 'Modèle WhatsApp requis',
  'NEEDS_REVIEW': 'Vérification requise',
  'CANCELLED': 'Annulé',
  'SKIPPED': 'Ignoré',
};

const messageStatusLabels = {
  'QUEUED': 'En file',
  'SUBMITTING': 'Soumission',
  'PENDING': 'En attente',
  'ACCEPTED': "Accepté par l'API",
  'SENT': 'Envoyé',
  'DELIVERED': 'Livré',
  'READ': 'Lu',
  'FAILED': 'Échec',
  'UNCERTAIN': 'Incertain',
  'SKIPPED': 'Ignoré',
};

const runStatusLabels = {
  'RUNNING': 'En cours',
  'PAUSED': 'En pause',
  'STOPPED': 'Arrêtée',
  'COMPLETED': 'Terminée',
};
