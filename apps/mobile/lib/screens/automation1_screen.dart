import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/theme.dart';
import '../widgets/common.dart';
import '../widgets/import_flow.dart';
import '../widgets/media_widgets.dart';
import '../widgets/run_progress.dart';

Future<bool> voiceNoteSupported() async {
  try {
    final providers = (await api.get('/providers') as List).cast<Map>();
    final conns = (await api.get('/connections') as List).cast<Map>();
    final active = conns.where((c) => c['isActive'] == true).firstOrNull;
    final p = providers.where((p) => p['id'] == (active?['provider'] ?? 'sendzen')).firstOrNull;
    return ((p?['capabilities'] as Map?)?['sendVoiceNote'] as Map?)?['status'] == 'SUPPORTED';
  } catch (_) {
    return false;
  }
}

Future<int> templateRequiredCount(String type) async {
  final r = await api.get('/history', query: {'automation': type, 'status': 'TEMPLATE_REQUIRED', 'pageSize': 1});
  return ((r as Map)['total'] as int?) ?? 0;
}

class Automation1Screen extends StatefulWidget {
  const Automation1Screen({super.key});

  @override
  State<Automation1Screen> createState() => _Automation1ScreenState();
}

class _Automation1ScreenState extends State<Automation1Screen> {
  int _refresh = 0;

  Future<Map<String, dynamic>> _load() async {
    final cfg = Map<String, dynamic>.from(await api.get('/automations/A1/config') as Map);
    return {'cfg': cfg, 'voice': await voiceNoteSupported(), 'tpl': await templateRequiredCount('A1')};
  }

  @override
  Widget build(BuildContext context) {
    return AsyncView<Map<String, dynamic>>(
      refreshKey: _refresh,
      load: _load,
      builder: (context, data, reload) {
        final cfg = data['cfg'] as Map<String, dynamic>;
        return PageBody(onRefresh: reload, children: [
          SectionCard(
            title: 'CONTENU DE LA SÉQUENCE',
            icon: Icons.format_list_numbered,
            subtitle: 'Ordre strict : Audio, puis Texte 1, puis Texte 2',
            trailing: Wrap(spacing: 4, children: [
              IconButton(
                tooltip: 'Présets',
                icon: const Icon(Icons.bookmarks_outlined),
                onPressed: () => showPresetsSheet(context,
                    type: 'A1',
                    currentPayload: {
                      'audioMediaId': (cfg['audio'] as Map?)?['id'],
                      'text1': cfg['text1'],
                      'text2': cfg['text2'],
                    },
                    onApplied: () => setState(() => _refresh++)),
              ),
            ]),
            child: const Row(children: [
              _StepChip(n: 1, label: 'AUDIO', icon: Icons.graphic_eq),
              Icon(Icons.arrow_forward, size: 18),
              _StepChip(n: 2, label: 'TEXTE 1', icon: Icons.notes),
              Icon(Icons.arrow_forward, size: 18),
              _StepChip(n: 3, label: 'TEXTE 2', icon: Icons.notes),
            ]),
          ),
          AudioSlot(
            title: 'AUDIO 1',
            media: cfg['audio'] as Map<String, dynamic>?,
            voiceNoteSupported: data['voice'] as bool,
            onSet: (id) async {
              await runAction(context, () => api.put('/automations/A1/audio', {'mediaId': id}), success: 'Audio enregistré');
              setState(() => _refresh++);
            },
          ),
          _TextEditorCard(title: 'TEXTE 1', which: 'text1', initial: cfg['text1'] as String? ?? ''),
          _TextEditorCard(title: 'TEXTE 2', which: 'text2', initial: cfg['text2'] as String? ?? ''),
          SectionCard(
            title: 'Tester sur mon numéro',
            icon: Icons.send_to_mobile,
            subtitle: 'Envoie la vraie séquence uniquement au numéro de test (Réglages)',
            child: Align(
              alignment: Alignment.centerLeft,
              child: BusyButton(label: 'TESTER LA SÉQUENCE', icon: Icons.play_circle_outline, onPressed: () => runSequenceTest(context, 'A1')),
            ),
          ),
          ImportPanel(
            automationType: 'A1',
            sequenceLabel: 'Audio + Texte 1 + Texte 2',
            onStarted: () => setState(() => _refresh++),
          ),
          RunProgressCard(automationType: 'A1', refreshKey: _refresh),
          TemplateFollowupCard(automationType: 'A1', count: data['tpl'] as int, onStarted: () => setState(() => _refresh++)),
          WindowPolicyCard(type: 'A1', policy: cfg['windowPolicy'] as String, onChanged: () => setState(() => _refresh++)),
        ]);
      },
    );
  }
}

class _StepChip extends StatelessWidget {
  const _StepChip({required this.n, required this.label, required this.icon});
  final int n;
  final String label;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 4),
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 6),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.primary.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(children: [
          Icon(icon, size: 20),
          const SizedBox(height: 4),
          Text('$n. $label', textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12)),
        ]),
      ),
    );
  }
}

class _TextEditorCard extends StatefulWidget {
  const _TextEditorCard({required this.title, required this.which, required this.initial});
  final String title;
  final String which;
  final String initial;

  @override
  State<_TextEditorCard> createState() => _TextEditorCardState();
}

class _TextEditorCardState extends State<_TextEditorCard> {
  late final TextEditingController _c = TextEditingController(text: widget.initial);
  late String _saved = widget.initial;

  bool get _dirty => _c.text != _saved;

  Future<void> _save() async {
    final r = await runAction(context, () => api.put('/automations/A1/texts/${widget.which}', {'value': _c.text}), success: '${widget.title} enregistré');
    if (r != null) setState(() => _saved = _c.text);
  }

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: widget.title,
      icon: Icons.notes,
      trailing: _dirty ? const StatusBadge('Non enregistré', tone: Tone.warning, dense: true) : const StatusBadge('Enregistré', tone: Tone.ok, dense: true),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        TextField(
          controller: _c,
          minLines: 5,
          maxLines: 14,
          maxLength: 4096,
          onChanged: (_) => setState(() {}),
          decoration: const InputDecoration(hintText: 'Votre message…', alignLabelWithHint: true),
        ),
        Wrap(spacing: 8, runSpacing: 8, children: [
          BusyButton(label: 'Sauvegarder', icon: Icons.save_outlined, onPressed: _dirty ? _save : null),
          OutlinedButton.icon(
            onPressed: () => showDialog<void>(
              context: context,
              builder: (ctx) => AlertDialog(
                title: Text('Aperçu — ${widget.title}'),
                content: Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: const Color(0xFFDCF8C6), borderRadius: BorderRadius.circular(12)),
                  child: Text(_c.text.isEmpty ? '(vide)' : _c.text, style: const TextStyle(color: Colors.black87)),
                ),
                actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Fermer'))],
              ),
            ),
            icon: const Icon(Icons.visibility_outlined),
            label: const Text('Prévisualiser'),
          ),
          OutlinedButton.icon(
            onPressed: _c.text.isEmpty ? null : () => setState(_c.clear),
            icon: const Icon(Icons.clear_all),
            label: const Text('Vider'),
          ),
          if (_dirty)
            TextButton(onPressed: () => setState(() => _c.text = _saved), child: const Text('Annuler les modifications')),
        ]),
      ]),
    );
  }
}

class WindowPolicyCard extends StatelessWidget {
  const WindowPolicyCard({super.key, required this.type, required this.policy, required this.onChanged});
  final String type;
  final String policy;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: 'Règle de conformité (fenêtre de 24 h)',
      icon: Icons.gavel,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const Text(
          'Avant chaque envoi, le serveur vérifie la date du dernier message reçu du client. '
          'Au-delà de 24 h : « Modèle WhatsApp requis » (jamais de contournement).',
        ),
        const SizedBox(height: 8),
        RadioGroup<String>(
          groupValue: policy,
          onChanged: (v) async {
            if (v == null) return;
            await runAction(context, () => api.put('/automations/$type/window-policy', {'policy': v}), success: 'Règle enregistrée');
            onChanged();
          },
          child: const Column(children: [
            RadioListTile<String>(
              contentPadding: EdgeInsets.zero,
              value: 'ALLOW_UNKNOWN',
              title: Text('Fenêtre inconnue : laisser le fournisseur décider'),
              subtitle: Text('Si aucun message du client n’est enregistré chez nous, l’envoi est tenté ; un refus est marqué « Modèle requis ».'),
            ),
            RadioListTile<String>(
              contentPadding: EdgeInsets.zero,
              value: 'REQUIRE_KNOWN',
              title: Text('Strict : exiger un message client reçu depuis moins de 24 h'),
            ),
          ]),
        ),
      ]),
    );
  }
}
