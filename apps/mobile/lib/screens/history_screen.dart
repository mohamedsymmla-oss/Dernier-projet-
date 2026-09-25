import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../widgets/common.dart';

class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key});

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  final _q = TextEditingController();
  String? _automation;
  String? _status;
  String? _result;
  String? _mode;
  String? _provider;
  DateTimeRange? _range;
  bool _includeTests = false;
  int _page = 1;
  int _refresh = 0;

  void _apply(VoidCallback f) => setState(() {
        f();
        _page = 1;
        _refresh++;
      });

  @override
  Widget build(BuildContext context) {
    final runId = GoRouterState.of(context).uri.queryParameters['run'];
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
        child: TextField(
          controller: _q,
          keyboardType: TextInputType.phone,
          decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Rechercher par numéro'),
          onSubmitted: (_) => _apply(() {}),
        ),
      ),
      SizedBox(
        height: 56,
        child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8), children: [
          if (runId != null)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: InputChip(label: const Text('Campagne sélectionnée'), onDeleted: () => context.go('/historique')),
            ),
          _drop('Automatisation', _automation, {'A1': 'Automation 1', 'A2': 'Automation 2'}, (v) => _apply(() => _automation = v)),
          _drop('Résultat', _result, {'success': 'Succès', 'failure': 'Échec'}, (v) => _apply(() => _result = v)),
          _drop('Statut', _status, recipientStatusLabels, (v) => _apply(() => _status = v)),
          _drop('Mode', _mode, {'PRODUCTION': 'Production', 'TEST': 'Test'}, (v) => _apply(() => _mode = v)),
          _drop('Fournisseur', _provider, {'sendzen': 'SendZen'}, (v) => _apply(() => _provider = v)),
          Padding(
            padding: const EdgeInsets.only(right: 6),
            child: ActionChip(
              avatar: const Icon(Icons.date_range, size: 16),
              label: Text(_range == null ? 'Date' : '${fmtDate(_range!.start.toIso8601String())} au ${fmtDate(_range!.end.toIso8601String())}'),
              onPressed: () async {
                final r = await showDateRangePicker(context: context, firstDate: DateTime(2024), lastDate: DateTime.now().add(const Duration(days: 1)));
                _apply(() => _range = r);
              },
            ),
          ),
          FilterChip(label: const Text('Inclure les tests'), selected: _includeTests, onSelected: (v) => _apply(() => _includeTests = v)),
        ]),
      ),
      Expanded(
        child: AsyncView<Map>(
          refreshKey: '$_refresh-$runId',
          load: () async => await api.get(runId != null ? '/runs/$runId/recipients' : '/history', query: {
            'q': _q.text,
            'automation': _automation,
            'status': _status,
            'result': _result,
            'mode': _mode,
            'provider': _provider,
            'includeTests': _includeTests ? 'true' : null,
            'from': _range?.start.toUtc().toIso8601String(),
            'to': _range?.end.add(const Duration(days: 1)).toUtc().toIso8601String(),
            'page': _page,
          }) as Map,
          builder: (context, d, reload) {
            final items = (d['items'] as List).cast<Map>();
            final total = d['total'] as int;
            if (items.isEmpty) return const EmptyState(icon: Icons.history, message: 'Aucun résultat');
            return RefreshIndicator(
              onRefresh: reload,
              child: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
                Text('$total résultat(s)', style: Theme.of(context).textTheme.bodySmall),
                const SizedBox(height: 6),
                for (final r in items) _RecipientCard(r: r),
                Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  IconButton(onPressed: _page > 1 ? () => setState(() {
                    _page--;
                    _refresh++;
                  }) : null, icon: const Icon(Icons.chevron_left)),
                  Text('Page $_page'),
                  IconButton(onPressed: _page * 50 < total ? () => setState(() {
                    _page++;
                    _refresh++;
                  }) : null, icon: const Icon(Icons.chevron_right)),
                ]),
              ]),
            );
          },
        ),
      ),
    ]);
  }

  Widget _drop(String label, String? value, Map<String, String> options, ValueChanged<String?> onChanged) {
    return Padding(
      padding: const EdgeInsets.only(right: 6),
      child: PopupMenuButton<String?>(
        onSelected: onChanged,
        itemBuilder: (_) => [
          const PopupMenuItem<String?>(value: null, child: Text('Tous')),
          for (final e in options.entries) PopupMenuItem<String?>(value: e.key, child: Text(e.value)),
        ],
        child: Chip(
          avatar: const Icon(Icons.filter_list, size: 16),
          label: Text(value == null ? label : '$label : ${options[value]}'),
          backgroundColor: value == null ? null : Theme.of(context).colorScheme.primaryContainer,
        ),
      ),
    );
  }
}

class _RecipientCard extends StatelessWidget {
  const _RecipientCard({required this.r});
  final Map r;

  @override
  Widget build(BuildContext context) {
    final steps = (r['steps'] as List?)?.cast<Map>() ?? const [];
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: () => context.go('/contacts/${r['contact_id']}'),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text('${r['phone_e164']}', style: const TextStyle(fontWeight: FontWeight.w700))),
              StatusBadge(recipientStatusLabels[r['status']] ?? '${r['status']}', tone: toneForRecipient(r['status'] as String?), dense: true),
            ]),
            Text('${r['automation_type'] == 'A1' ? 'Automation 1' : 'Automation 2'}'
                '${r['run_kind'] == 'TEST' ? ' (test)' : r['run_kind'] == 'TEMPLATE' ? ' (modèle)' : ''} • ${r['mode']} • ${fmtDateTime(r['updated_at'])}',
                style: Theme.of(context).textTheme.bodySmall),
            if (steps.isNotEmpty) ...[
              const SizedBox(height: 6),
              Wrap(spacing: 4, runSpacing: 4, children: [
                for (final s in steps)
                  StatusBadge('${s['label']} : ${messageStatusLabels[s['messageStatus'] ?? s['status']] ?? s['status']}',
                      tone: toneForMessage((s['messageStatus'] ?? s['status']) as String?), dense: true),
              ]),
            ],
            if (r['last_error'] != null)
              Row(children: [
                Expanded(child: Text('${r['last_error']}', style: const TextStyle(color: Colors.redAccent, fontSize: 12))),
                IconButton(icon: const Icon(Icons.copy, size: 16), onPressed: () => copyText(context, '${r['phone_e164']} ${r['last_error_kind']} ${r['last_error']}')),
                if (['FAILED', 'TEMPLATE_REQUIRED', 'NEEDS_REVIEW'].contains(r['status']))
                  TextButton(
                    onPressed: () async {
                      var uncertain = false;
                      if (r['status'] == 'NEEDS_REVIEW') {
                        uncertain = await confirm(context,
                            title: 'Relancer une étape incertaine ?',
                            message: 'L’envoi a été interrompu : le client a peut-être déjà reçu ce message. '
                                'Vérifiez sur WhatsApp avant de relancer, sinon il pourrait le recevoir deux fois.',
                            ok: 'J’ai vérifié, relancer');
                        if (!uncertain) return;
                      }
                      if (!context.mounted) return;
                      await runAction(context, () => api.post('/recipients/${r['id']}/retry', {'includeUncertain': uncertain}),
                          success: 'Relance programmée (étapes déjà acceptées non renvoyées)');
                    },
                    child: const Text('Relancer'),
                  ),
              ]),
          ]),
        ),
      ),
    );
  }
}
