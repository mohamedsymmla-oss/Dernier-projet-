import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:uuid/uuid.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import 'common.dart';

/// Progression en temps réel (actualisation toutes les 2 s) avec Pause / Reprendre / Arrêter.
class RunProgressCard extends StatefulWidget {
  const RunProgressCard({super.key, required this.automationType, this.refreshKey});
  final String automationType;
  final Object? refreshKey;

  @override
  State<RunProgressCard> createState() => _RunProgressCardState();
}

class _RunProgressCardState extends State<RunProgressCard> {
  Map<String, dynamic>? _p;
  Object? _error;
  Timer? _poll;
  Timer? _tick;
  Duration _serverOffset = Duration.zero;

  @override
  void initState() {
    super.initState();
    _load();
    _poll = Timer.periodic(const Duration(seconds: 2), (_) => _load());
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _p?['a2']?['nextSendAt'] != null) setState(() {});
    });
  }

  @override
  void didUpdateWidget(covariant RunProgressCard old) {
    super.didUpdateWidget(old);
    if (old.refreshKey != widget.refreshKey) _load();
  }

  @override
  void dispose() {
    _poll?.cancel();
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await api.get('/runs/active', query: {'type': widget.automationType});
      if (!mounted) return;
      setState(() {
        _p = r == null || r == '' ? null : Map<String, dynamic>.from(r as Map);
        _error = null;
        final st = parseDate(_p?['serverTime']);
        if (st != null) _serverOffset = st.difference(DateTime.now());
      });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_p == null) {
      return SectionCard(
        title: 'Progression',
        icon: Icons.timeline,
        child: _error != null ? Text('Actualisation impossible : $_error') : const Text('Aucune campagne lancée pour le moment.'),
      );
    }
    final run = _p!['run'] as Map;
    final c = _p!['counts'] as Map;
    final a2 = _p!['a2'] as Map?;
    final status = run['status'] as String;
    final total = (c['total'] as int).clamp(1, 1 << 30);
    final done = c['completed'] as int;
    final failed = c['failed'] as int;
    final id = run['id'] as String;

    String? countdown;
    if (a2?['nextSendAt'] != null) {
      final next = parseDate(a2!['nextSendAt'])!;
      final left = next.difference(DateTime.now().add(_serverOffset));
      countdown = fmtDelay(left.isNegative ? 0 : (left.inMilliseconds / 1000).ceil());
    }

    return SectionCard(
      title: widget.automationType == 'A1' ? 'AUTOMATISATION 1 — progression' : 'AUTOMATISATION 2 — progression',
      icon: Icons.timeline,
      subtitle: 'Démarrée le ${fmtDateTime(run['startedAt'])} • ${run['mode']}',
      trailing: StatusBadge(runStatusLabels[status] ?? status, tone: toneForRun(status)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (run['pauseReason'] != null && status == 'PAUSED')
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: StatusBadge('${run['pauseReason']}', tone: Tone.warning, icon: Icons.pause_circle_outline),
          ),
        LinearProgressIndicator(value: (done + failed) / total, minHeight: 10, borderRadius: BorderRadius.circular(6)),
        const SizedBox(height: 12),
        ResponsiveGrid(minItemWidth: 120, spacing: 8, children: [
          StatTile(label: 'Total', value: '${c['total']}', tone: Tone.info),
          StatTile(label: 'Terminés', value: '$done', tone: Tone.ok),
          StatTile(label: 'Restants', value: '${c['remaining']}', tone: Tone.inactive),
          StatTile(label: 'Échecs', value: '$failed', tone: failed > 0 ? Tone.error : Tone.inactive),
          StatTile(label: 'En cours', value: '${c['inProgress']}', tone: Tone.info),
          if (a2 != null) StatTile(label: 'Délai', value: fmtDelay(a2['delaySeconds'] as int), tone: Tone.info, icon: Icons.timer_outlined),
        ]),
        if (a2 != null && status == 'RUNNING') ...[
          const SizedBox(height: 10),
          InfoRow('Prochain contact', a2['nextContactPhone'] as String?),
          InfoRow('Prochain envoi dans', a2['currentlyProcessing'] == true ? 'envoi en cours…' : (countdown ?? '—')),
        ],
        if ((c['byStatus'] as Map)['TEMPLATE_REQUIRED'] != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: StatusBadge('${(c['byStatus'] as Map)['TEMPLATE_REQUIRED']} contact(s) : modèle WhatsApp requis', tone: Tone.warning, icon: Icons.description_outlined),
          ),
        if ((c['byStatus'] as Map)['NEEDS_REVIEW'] != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: StatusBadge('${(c['byStatus'] as Map)['NEEDS_REVIEW']} contact(s) : vérification requise (envoi interrompu)', tone: Tone.warning, icon: Icons.help_outline),
          ),
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          if (status == 'RUNNING')
            BusyButton(label: 'PAUSE', icon: Icons.pause, color: StatusColors.warning, onPressed: () async {
              await runAction(context, () => api.post('/runs/$id/pause'), success: 'Mise en pause : la position est conservée');
              await _load();
            }),
          if (status == 'PAUSED')
            BusyButton(label: 'REPRENDRE', icon: Icons.play_arrow, onPressed: () async {
              await runAction(context, () => api.post('/runs/$id/resume'), success: 'Reprise');
              await _load();
            }),
          if (status == 'RUNNING' || status == 'PAUSED')
            BusyButton(label: 'ARRÊTER', icon: Icons.stop, outlined: true, color: StatusColors.error, onPressed: () async {
              if (await confirm(context,
                  title: 'Arrêter la campagne ?',
                  message: 'Le contact en cours termine sa séquence ; les suivants sont annulés. L’historique est conservé.',
                  ok: 'Arrêter',
                  danger: true)) {
                if (!context.mounted) return;
                await runAction(context, () => api.post('/runs/$id/stop'), success: 'Campagne arrêtée');
                await _load();
              }
            }),
          if (failed > 0 && status != 'PAUSED')
            BusyButton(label: 'Relancer les échecs', icon: Icons.replay, outlined: true, onPressed: () async {
              final r = await runAction(context, () => api.post('/runs/$id/retry', {'includeUncertain': false}));
              if (r != null && context.mounted) {
                showSnack(context, '${(r as Map)['retried']} relancé(s) — étapes déjà acceptées jamais renvoyées. '
                    '${r['skippedPermanent'] ?? 0} erreur(s) définitive(s) non relancée(s).');
              }
              await _load();
            }),
          OutlinedButton.icon(
            onPressed: () => context.go('/historique?run=$id'),
            icon: const Icon(Icons.list_alt),
            label: const Text('Détail'),
          ),
        ]),
      ]),
    );
  }
}

/// Carte « Modèle WhatsApp requis » : envoi d'un modèle approuvé aux contacts hors fenêtre de 24 h.
class TemplateFollowupCard extends StatelessWidget {
  const TemplateFollowupCard({super.key, required this.automationType, required this.count, required this.onStarted});
  final String automationType;
  final int count;
  final VoidCallback onStarted;

  @override
  Widget build(BuildContext context) {
    if (count == 0) return const SizedBox.shrink();
    return SectionCard(
      title: 'Modèle WhatsApp requis',
      icon: Icons.description_outlined,
      subtitle: '$count contact(s) hors fenêtre de conversation de 24 h',
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const Text(
          'WhatsApp n’autorise plus de message libre pour ces contacts. Aucun contournement n’est tenté : '
          'vous pouvez leur envoyer un modèle approuvé. S’ils répondent, relancez ensuite la séquence.',
        ),
        const SizedBox(height: 10),
        Align(
          alignment: Alignment.centerLeft,
          child: BusyButton(label: 'Choisir un modèle approuvé', icon: Icons.send, onPressed: () => _pick(context)),
        ),
      ]),
    );
  }

  Future<void> _pick(BuildContext context) async {
    final conns = (await api.get('/connections') as List).cast<Map>();
    final active = conns.where((c) => c['isActive'] == true).firstOrNull;
    if (active == null || !context.mounted) return;
    final tpls = await runAction(context, () => api.get('/connections/${active['id']}/templates'));
    if (tpls == null || !context.mounted) return;
    final list = (tpls as List).cast<Map>();
    final chosen = await showDialog<Map>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('Modèles WhatsApp'),
        children: [
          if (list.isEmpty) const Padding(padding: EdgeInsets.all(16), child: Text('Aucun modèle trouvé pour ce WABA.')),
          for (final t in list)
            SimpleDialogOption(
              onPressed: t['usable'] == true ? () => Navigator.pop(ctx, t) : null,
              child: ListTile(
                enabled: t['usable'] == true,
                title: Text('${t['name']} (${t['language']})'),
                subtitle: Text(t['usable'] == true ? '${t['category']} • ${t['status']}' : '${t['reason']}'),
              ),
            ),
        ],
      ),
    );
    if (chosen == null || !context.mounted) return;
    final ok = await confirm(context,
        title: 'Envoyer le modèle ?',
        message: 'Le modèle « ${chosen['name']} » sera envoyé à $count contact(s). Chaque contact ne le recevra qu’une seule fois.',
        ok: 'CONFIRMER ET ENVOYER');
    if (!ok || !context.mounted) return;
    final r = await runAction(
      context,
      () => api.post('/automations/$automationType/template-followup', {
        'templateName': chosen['name'],
        'language': chosen['language'],
        'clientRequestId': const Uuid().v4(),
        'confirm': true,
      }),
      success: 'Envoi du modèle démarré',
    );
    if (r != null) onStarted();
  }
}

/// Test de la séquence complète sur le numéro de test uniquement, avec résultats détaillés.
Future<void> runSequenceTest(BuildContext context, String type) async {
  final r = await runAction(context, () => api.post('/automations/$type/test', {'clientRequestId': const Uuid().v4()}));
  if (r == null || !context.mounted) return;
  final runId = ((r as Map)['run'] as Map)['id'] as String;
  await showDialog<void>(context: context, builder: (_) => _TestRunDialog(runId: runId));
}

class _TestRunDialog extends StatefulWidget {
  const _TestRunDialog({required this.runId});
  final String runId;

  @override
  State<_TestRunDialog> createState() => _TestRunDialogState();
}

class _TestRunDialogState extends State<_TestRunDialog> {
  Map? _recipient;
  String _status = 'RUNNING';
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _load();
    _t = Timer.periodic(const Duration(seconds: 2), (_) => _load());
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final p = await api.get('/runs/${widget.runId}');
      final recs = await api.get('/runs/${widget.runId}/recipients');
      if (!mounted) return;
      setState(() {
        _status = ((p as Map)['run'] as Map)['status'] as String;
        final items = ((recs as Map)['items'] as List);
        _recipient = items.isEmpty ? null : items.first as Map;
      });
      if (_status == 'COMPLETED') _t?.cancel();
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final steps = (_recipient?['steps'] as List?)?.cast<Map>() ?? const [];
    return AlertDialog(
      title: const Text('Test de la séquence'),
      content: SizedBox(
        width: 420,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Destinataire : ${_recipient?['phone_e164'] ?? '…'}'),
          const SizedBox(height: 8),
          if (_status != 'COMPLETED') const LinearProgressIndicator(),
          for (final s in steps)
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text('${s['label']}'),
              subtitle: s['error'] != null ? Text('${s['error']}') : null,
              trailing: StatusBadge(messageStatusLabels[s['messageStatus'] ?? s['status']] ?? '${s['status']}',
                  tone: toneForMessage((s['messageStatus'] ?? s['status']) as String?), dense: true),
            ),
          if (_recipient?['last_error'] != null) Text('${_recipient!['last_error']}', style: const TextStyle(color: StatusColors.error)),
          const SizedBox(height: 8),
          Text('« Accepté par l’API » ne signifie pas « livré » : les statuts Envoyé / Livré / Lu arrivent par webhook.',
              style: Theme.of(context).textTheme.bodySmall),
        ]),
      ),
      actions: [FilledButton(onPressed: () => Navigator.pop(context), child: const Text('Fermer'))],
    );
  }
}

/// Présets : enregistrer / appliquer / supprimer (sans jamais toucher à la connexion fournisseur).
Future<void> showPresetsSheet(BuildContext context, {required String type, required Map<String, dynamic> currentPayload, required VoidCallback onApplied}) async {
  await showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (ctx) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: AsyncView<List>(
          load: () async => (await api.get('/presets', query: {'type': type})) as List,
          builder: (ctx, list, reload) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Présets ${type == 'A1' ? 'Automation 1' : 'Automation 2'}', style: Theme.of(ctx).textTheme.titleLarge),
            const Text('La connexion fournisseur n’est jamais incluse dans un préset.'),
            const SizedBox(height: 8),
            if (list.isEmpty) const EmptyState(icon: Icons.bookmarks_outlined, message: 'Aucun préset enregistré'),
            for (final p in list.cast<Map>())
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text('${p['name']}'),
                subtitle: Text(_presetSummary(p['payload'] as Map)),
                trailing: Wrap(children: [
                  TextButton(
                    onPressed: () async {
                      final ok = await runAction(ctx, () => api.post('/presets/${p['id']}/apply'), success: 'Préset appliqué');
                      if (ok != null && ctx.mounted) {
                        Navigator.pop(ctx);
                        onApplied();
                      }
                    },
                    child: const Text('Appliquer'),
                  ),
                  IconButton(
                    icon: const Icon(Icons.delete_outline),
                    onPressed: () async {
                      await runAction(ctx, () => api.delete('/presets/${p['id']}'));
                      await reload();
                    },
                  ),
                ]),
              ),
            const SizedBox(height: 8),
            FilledButton.icon(
              icon: const Icon(Icons.bookmark_add_outlined),
              label: const Text('Enregistrer la configuration actuelle'),
              onPressed: () async {
                final name = await promptText(ctx, title: 'Nom du préset', hint: 'Ex : Automatisation lente 10 sec');
                if (name == null || name.isEmpty || !ctx.mounted) return;
                await runAction(ctx, () => api.post('/presets', {'automationType': type, 'name': name, 'payload': currentPayload}), success: 'Préset enregistré');
                await reload();
              },
            ),
          ]),
        ),
      ),
    ),
  );
}

String _presetSummary(Map p) => [
      if (p['delaySeconds'] != null) 'Délai ${fmtDelay(p['delaySeconds'] as int)}',
      if (p['photoCount'] != null) '${p['photoCount']} photos',
      if (p['audioMediaId'] != null) 'audio',
      if (p['text1'] != null) 'texte 1',
      if (p['text2'] != null) 'texte 2',
    ].join(' • ');
