import 'dart:convert';

import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../widgets/common.dart';

/// Journal technique pour le diagnostic. Le serveur n'y écrit jamais de secret.
class LogsScreen extends StatefulWidget {
  const LogsScreen({super.key});

  @override
  State<LogsScreen> createState() => _LogsScreenState();
}

class _LogsScreenState extends State<LogsScreen> {
  bool _errorsOnly = false;
  final _q = TextEditingController();
  int _refresh = 0;

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 4,
      child: Column(children: [
        const TabBar(isScrollable: true, tabs: [Tab(text: 'Appels fournisseur'), Tab(text: 'Webhooks'), Tab(text: 'Synchronisations'), Tab(text: 'Audit')]),
        Expanded(
          child: TabBarView(children: [
            Column(children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: Row(children: [
                  Expanded(
                    child: TextField(
                      controller: _q,
                      decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'message ID, request ID, run ID, endpoint'),
                      onSubmitted: (_) => setState(() => _refresh++),
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilterChip(label: const Text('Erreurs'), selected: _errorsOnly, onSelected: (v) => setState(() {
                    _errorsOnly = v;
                    _refresh++;
                  })),
                ]),
              ),
              Expanded(
                child: AsyncView<List>(
                  refreshKey: _refresh,
                  load: () async => await api.get('/logs/provider', query: {'errorsOnly': _errorsOnly ? 'true' : null, 'q': _q.text}) as List,
                  builder: (context, list, reload) => list.isEmpty
                      ? const EmptyState(icon: Icons.terminal, message: 'Aucun appel enregistré')
                      : RefreshIndicator(
                          onRefresh: reload,
                          child: ListView(padding: const EdgeInsets.all(16), children: [for (final l in list.cast<Map>()) _ProviderLogTile(l: l)]),
                        ),
                ),
              ),
            ]),
            AsyncView<List>(
              load: () async => await api.get('/logs/webhooks') as List,
              builder: (context, list, reload) => list.isEmpty
                  ? const EmptyState(icon: Icons.webhook, message: 'Aucun webhook reçu')
                  : RefreshIndicator(
                      onRefresh: reload,
                      child: ListView(padding: const EdgeInsets.all(16), children: [
                        for (final w in list.cast<Map>())
                          Card(
                            margin: const EdgeInsets.only(bottom: 8),
                            child: ExpansionTile(
                              title: Text('${fmtDateTime(w['received_at'])} • ${w['event_count'] ?? '?'} événement(s)'),
                              subtitle: Wrap(spacing: 4, runSpacing: 4, children: [
                                StatusBadge(w['signature_verified'] == true ? 'Signature vérifiée' : 'Non signé', tone: w['signature_verified'] == true ? Tone.ok : Tone.warning, dense: true),
                                StatusBadge('${w['process_status']}', tone: w['process_status'] == 'PROCESSED' ? Tone.ok : w['process_status'] == 'FAILED' ? Tone.error : Tone.info, dense: true),
                                if ((w['duplicate_count'] as int? ?? 0) > 0) StatusBadge('${w['duplicate_count']} doublon(s) ignoré(s)', tone: Tone.inactive, dense: true),
                                StatusBadge('${w['source']}', tone: Tone.inactive, dense: true),
                              ]),
                              children: [
                                Padding(
                                  padding: const EdgeInsets.all(12),
                                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                                    InfoRow('event_id', '${w['id']}', copyable: true),
                                    if (w['process_error'] != null) InfoRow('Erreur', '${w['process_error']}', copyable: true),
                                    SelectableText(const JsonEncoder.withIndent('  ').convert(w['payload']), style: const TextStyle(fontFamily: 'monospace', fontSize: 11)),
                                  ]),
                                ),
                              ],
                            ),
                          ),
                      ]),
                    ),
            ),
            AsyncView<List>(
              load: () async => await api.get('/logs/sync') as List,
              builder: (context, list, reload) => list.isEmpty
                  ? const EmptyState(icon: Icons.sync, message: 'Aucune synchronisation')
                  : ListView(padding: const EdgeInsets.all(16), children: [
                      for (final s in list.cast<Map>())
                        Card(
                          margin: const EdgeInsets.only(bottom: 8),
                          child: ListTile(
                            title: Text(fmtDateTime(s['started_at'])),
                            subtitle: Text('Retraités : ${s['reprocessed']} • récupérés : ${s['fetched']} • nouveaux : ${s['new_events']} • doublons : ${s['duplicates']}\n${s['detail'] ?? ''}'),
                            isThreeLine: true,
                          ),
                        ),
                    ]),
            ),
            AsyncView<List>(
              load: () async => await api.get('/logs/audit') as List,
              builder: (context, list, reload) => ListView(padding: const EdgeInsets.all(16), children: [
                for (final a in list.cast<Map>())
                  ListTile(
                    dense: true,
                    title: Text('${a['action']}'),
                    subtitle: Text('${fmtDateTime(a['created_at'])} • ${a['email'] ?? 'système'}${a['entity_id'] != null ? ' • ${a['entity_type']} ${a['entity_id']}' : ''}\n${jsonEncode(a['details'])}'),
                    isThreeLine: true,
                  ),
              ]),
            ),
          ]),
        ),
      ]),
    );
  }
}

class _ProviderLogTile extends StatelessWidget {
  const _ProviderLogTile({required this.l});
  final Map l;

  @override
  Widget build(BuildContext context) {
    final status = l['http_status'] as int?;
    final isError = l['error'] != null || (status ?? 0) >= 400;
    final text = [
      'Date : ${fmtDateTime(l['created_at'])}',
      'Fournisseur : ${l['provider']}',
      'Endpoint : ${l['method']} ${l['endpoint']}',
      'HTTP : ${status ?? 'aucune réponse'}',
      'Request ID : ${l['request_id'] ?? '—'}',
      'Message ID : ${l['provider_message_id'] ?? '—'}',
      'Tentative : ${l['attempt'] ?? '—'}',
      'Durée : ${l['duration_ms']} ms',
      'Run : ${l['run_id'] ?? '—'}',
      'Destinataire : ${l['recipient_id'] ?? '—'}',
      if (l['error'] != null) 'Erreur : ${l['error']}',
    ].join('\n');
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ExpansionTile(
        leading: Icon(isError ? Icons.error : Icons.check_circle, color: isError ? StatusColors.error : StatusColors.ok),
        title: Text('${l['method']} ${l['endpoint']}', style: const TextStyle(fontFamily: 'monospace', fontSize: 13)),
        subtitle: Text('${status ?? '—'} • ${fmtDateTime(l['created_at'])}${l['error'] != null ? '\n${l['error']}' : ''}'),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              SelectableText(text, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
              if (l['response_snippet'] != null) ...[
                const SizedBox(height: 8),
                SelectableText('Réponse : ${l['response_snippet']}', style: const TextStyle(fontFamily: 'monospace', fontSize: 11)),
              ],
              Align(
                alignment: Alignment.centerRight,
                child: TextButton.icon(
                  onPressed: () => copyText(context, '$text\nRéponse : ${l['response_snippet'] ?? ''}', message: 'Copié pour le débogage'),
                  icon: const Icon(Icons.copy, size: 16),
                  label: const Text('Copier'),
                ),
              ),
            ]),
          ),
        ],
      ),
    );
  }
}
