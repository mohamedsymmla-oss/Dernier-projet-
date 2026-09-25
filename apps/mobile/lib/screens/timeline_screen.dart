import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../widgets/common.dart';

class TimelineScreen extends StatelessWidget {
  const TimelineScreen({super.key, required this.contactId});
  final String contactId;

  @override
  Widget build(BuildContext context) {
    return AsyncView<Map>(
      load: () async => await api.get('/contacts/$contactId/timeline') as Map,
      builder: (context, d, reload) {
        final c = d['contact'] as Map;
        final events = (d['events'] as List).cast<Map>();
        return PageBody(onRefresh: reload, children: [
          SectionCard(
            title: '${c['phone_e164']}',
            icon: Icons.person_outline,
            child: Column(children: [
              InfoRow('Ajouté le', fmtDateTime(c['created_at'])),
              InfoRow('Dernier message reçu', fmtDateTime(c['last_inbound_at'])),
              InfoRow('Dernière réponse', fmtDateTime(c['last_reply_at'])),
              InfoRow('Automation 1', '${recipientStatusLabels[c['a1_status']] ?? '—'} ${c['a1_first_sent_at'] != null ? '(envoyée le ${fmtDateTime(c['a1_first_sent_at'])})' : ''}'),
              InfoRow('Réponse après A1', c['responded_after_a1'] == true ? 'Oui — ${fmtDateTime(c['responded_after_a1_at'])} (${c['responded_after_a1_message_type']})' : 'Non'),
              InfoRow('Automation 2', '${recipientStatusLabels[c['a2_status']] ?? '—'} ${c['a2_first_sent_at'] != null ? '(envoyée le ${fmtDateTime(c['a2_first_sent_at'])})' : ''}'),
              if (c['last_error'] != null) InfoRow('Dernière erreur', '${c['last_error']}', copyable: true),
            ]),
          ),
          SectionCard(
            title: 'Chronologie',
            icon: Icons.timeline,
            child: events.isEmpty
                ? const EmptyState(icon: Icons.hourglass_empty, message: 'Aucun événement')
                : Column(children: [
                    for (var i = 0; i < events.length; i++) _TimelineRow(event: events[i], last: i == events.length - 1),
                  ]),
          ),
        ]);
      },
    );
  }
}

class _TimelineRow extends StatelessWidget {
  const _TimelineRow({required this.event, required this.last});
  final Map event;
  final bool last;

  Tone get _tone => switch (event['type']) {
        'failed' => Tone.error,
        'template_required' || 'needs_review' => Tone.warning,
        'inbound' => Tone.info,
        'delivered' || 'read' || 'completed' => Tone.ok,
        _ => Tone.inactive,
      };

  @override
  Widget build(BuildContext context) {
    final color = toneColor(_tone);
    return IntrinsicHeight(
      child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SizedBox(
          width: 64,
          child: Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(fmtTime(event['at']), style: const TextStyle(fontWeight: FontWeight.w700, fontFeatures: [FontFeature.tabularFigures()])),
              Text(fmtDate(event['at']), style: const TextStyle(fontSize: 10)),
            ]),
          ),
        ),
        Column(children: [
          Container(width: 12, height: 12, margin: const EdgeInsets.only(top: 4), decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          if (!last) Expanded(child: Container(width: 2, color: color.withValues(alpha: 0.3))),
        ]),
        const SizedBox(width: 12),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${event['label']}${event['automation'] != null ? '  ·  ${event['automation']}' : ''}',
                  style: const TextStyle(fontWeight: FontWeight.w600)),
              if (event['detail'] != null && '${event['detail']}'.isNotEmpty)
                Text('${event['detail']}', style: Theme.of(context).textTheme.bodySmall),
            ]),
          ),
        ),
      ]),
    );
  }
}
