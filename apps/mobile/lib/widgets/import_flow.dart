import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:uuid/uuid.dart';

import '../core/api.dart';
import '../core/theme.dart';
import 'common.dart';

/// Import d'une liste de numéros → analyse → confirmation complète → démarrage.
/// Aucun envoi n'a lieu avant « CONFIRMER ET DÉMARRER ».
class ImportPanel extends StatefulWidget {
  const ImportPanel({super.key, required this.automationType, required this.sequenceLabel, required this.onStarted, this.allowResponders = false});
  final String automationType;
  final String sequenceLabel;
  final VoidCallback onStarted;
  final bool allowResponders;

  @override
  State<ImportPanel> createState() => _ImportPanelState();
}

class _ImportPanelState extends State<ImportPanel> {
  final _text = TextEditingController();
  Map<String, dynamic>? _analysis;
  bool _busy = false;

  Future<void> _analyze({required String source, String? content, String? filename}) async {
    setState(() => _busy = true);
    try {
      final r = source == 'responders'
          ? await api.post('/imports/responders')
          : await api.post('/imports', {
              'automationType': widget.automationType,
              'source': source,
              'content': content,
              'filename': filename,
            });
      setState(() => _analysis = Map<String, dynamic>.from(r as Map));
    } catch (e) {
      if (mounted) await showError(context, e, title: 'Import impossible');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _pickFile() async {
    final f = await FilePicker.pickFile(type: FileType.custom, allowedExtensions: ['csv', 'txt']);
    if (f == null) return;
    final bytes = await f.readAsBytes();
    final content = utf8.decode(bytes, allowMalformed: true);
    await _analyze(source: (f.extension ?? '').toLowerCase() == 'csv' ? 'csv' : 'txt', content: content, filename: f.name);
  }

  @override
  Widget build(BuildContext context) {
    final a = _analysis;
    return SectionCard(
      title: 'Liste des destinataires',
      icon: Icons.playlist_add,
      subtitle: 'Coller, CSV ou TXT — analyse avant tout envoi',
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        TextField(
          controller: _text,
          minLines: 4,
          maxLines: 10,
          keyboardType: TextInputType.multiline,
          decoration: const InputDecoration(
            hintText: '+223 76 12 34 56\n+22365432198\n…',
            labelText: 'Coller les numéros (un par ligne)',
            alignLabelWithHint: true,
          ),
        ),
        const SizedBox(height: 10),
        Wrap(spacing: 8, runSpacing: 8, children: [
          FilledButton.icon(
            onPressed: _busy ? null : () => _analyze(source: 'paste', content: _text.text),
            icon: _busy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.analytics_outlined),
            label: const Text('Analyser la liste'),
          ),
          OutlinedButton.icon(onPressed: _busy ? null : _pickFile, icon: const Icon(Icons.upload_file), label: const Text('Importer CSV / TXT')),
          if (widget.allowResponders)
            OutlinedButton.icon(
              onPressed: _busy ? null : () => _analyze(source: 'responders'),
              icon: const Icon(Icons.reply_all),
              label: const Text('Utiliser les personnes ayant répondu'),
            ),
        ]),
        if (a != null) ...[
          const SizedBox(height: 16),
          _AnalysisView(analysis: a),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: (a['counts']['eligible'] as int) > 0 ? () => _confirmAndStart(a) : null,
            icon: const Icon(Icons.play_arrow),
            label: Text('Préparer le démarrage (${a['counts']['eligible']} contacts)'),
          ),
        ],
      ]),
    );
  }

  Future<void> _confirmAndStart(Map<String, dynamic> a) async {
    Map<String, dynamic> readiness;
    try {
      readiness = Map<String, dynamic>.from(await api.get('/automations/${widget.automationType}/readiness') as Map);
    } catch (e) {
      if (mounted) await showError(context, e);
      return;
    }
    if (!mounted) return;
    if (readiness['ready'] != true) {
      await showError(context, ApiException('Impossible de démarrer : configuration incomplète', details: readiness['problems']));
      return;
    }
    final conn = readiness['connection'] as Map;
    final clientRequestId = const Uuid().v4(); // identifiant unique : un double clic ne crée pas deux campagnes
    final started = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => _ConfirmStartDialog(
        automationType: widget.automationType,
        eligible: a['counts']['eligible'] as int,
        provider: conn['provider'] == 'sendzen' ? 'SendZen' : '${conn['provider']}',
        phone: '${conn['phoneNumber']}',
        mode: '${conn['mode']}',
        sequence: widget.sequenceLabel,
        onConfirm: () => api.post('/runs', {
          'automationType': widget.automationType,
          'importId': a['importId'],
          'clientRequestId': clientRequestId,
          'confirm': true,
        }),
      ),
    );
    if (started == true && mounted) {
      setState(() {
        _analysis = null;
        _text.clear();
      });
      showSnack(context, 'Automatisation démarrée');
      widget.onStarted();
    }
  }
}

class _AnalysisView extends StatelessWidget {
  const _AnalysisView({required this.analysis});
  final Map<String, dynamic> analysis;

  @override
  Widget build(BuildContext context) {
    final c = analysis['counts'] as Map;
    final issues = (analysis['issues'] as List).cast<Map>();
    final already = (analysis['alreadyAutomated'] as List).cast<Map>();
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      ResponsiveGrid(minItemWidth: 130, spacing: 8, children: [
        StatTile(label: 'Importés', value: '${c['imported']}', tone: Tone.info),
        StatTile(label: 'Valides', value: '${c['valid']}', tone: Tone.ok),
        StatTile(label: 'Invalides', value: '${c['invalid']}', tone: (c['invalid'] as int) > 0 ? Tone.error : Tone.inactive),
        StatTile(label: 'Doublons', value: '${c['duplicatesInList']}', tone: (c['duplicatesInList'] as int) > 0 ? Tone.warning : Tone.inactive),
        StatTile(label: 'Déjà automatisés', value: '${c['alreadyAutomated']}', tone: (c['alreadyAutomated'] as int) > 0 ? Tone.warning : Tone.inactive),
        StatTile(label: 'Éligibles', value: '${c['eligible']}', tone: Tone.ok, icon: Icons.check),
      ]),
      if ((c['emptyLines'] ?? 0) > 0)
        Padding(padding: const EdgeInsets.only(top: 6), child: Text('${c['emptyLines']} ligne(s) vide(s) ignorée(s).', style: Theme.of(context).textTheme.bodySmall)),
      if (c['notRespondedAfterA1'] != null && (c['notRespondedAfterA1'] as int) > 0)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: StatusBadge('${c['notRespondedAfterA1']} numéro(s) sans réponse enregistrée après Automation 1', tone: Tone.warning, icon: Icons.info_outline),
        ),
      if (analysis['mode'] == 'TEST')
        const Padding(padding: EdgeInsets.only(top: 8), child: StatusBadge('Analyse en MODE TEST', tone: Tone.warning, icon: Icons.science)),
      if (issues.isNotEmpty)
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: Text('Lignes écartées (${issues.length})'),
          subtitle: const Text('Rien n’est supprimé sans explication'),
          children: [
            for (final i in issues)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: Text('L${i['line']}'),
                title: Text('${i['raw']}'),
                subtitle: Text('${i['reason']}'),
                trailing: StatusBadge(i['status'] == 'INVALID' ? 'Invalide' : 'Doublon', tone: i['status'] == 'INVALID' ? Tone.error : Tone.warning, dense: true),
              ),
          ],
        ),
      if (already.isNotEmpty)
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: Text('Déjà automatisés (${c['alreadyAutomated']})'),
          subtitle: const Text('Ils ne recevront pas la séquence une deuxième fois'),
          children: [
            for (final i in already)
              ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: Text('L${i['line']}'), title: Text('${i['phone']}'), trailing: Text('${i['status']}')),
          ],
        ),
    ]);
  }
}

class _ConfirmStartDialog extends StatefulWidget {
  const _ConfirmStartDialog({
    required this.automationType,
    required this.eligible,
    required this.provider,
    required this.phone,
    required this.mode,
    required this.sequence,
    required this.onConfirm,
  });
  final String automationType;
  final int eligible;
  final String provider;
  final String phone;
  final String mode;
  final String sequence;
  final Future<dynamic> Function() onConfirm;

  @override
  State<_ConfirmStartDialog> createState() => _ConfirmStartDialogState();
}

class _ConfirmStartDialogState extends State<_ConfirmStartDialog> {
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      icon: const Icon(Icons.warning_amber_rounded, color: StatusColors.warning, size: 36),
      title: Text(widget.automationType == 'A1' ? 'AUTOMATISATION 1' : 'AUTOMATISATION 2'),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('Vous êtes sur le point de traiter :'),
        const SizedBox(height: 8),
        Text('${widget.eligible} contacts', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 12),
        InfoRow('Fournisseur', widget.provider),
        InfoRow('Numéro', widget.phone),
        InfoRow('Mode', widget.mode),
        InfoRow('Séquence', widget.sequence),
      ]),
      actions: [
        TextButton(onPressed: _busy ? null : () => Navigator.pop(context, false), child: const Text('RETOUR')),
        FilledButton.icon(
          onPressed: _busy
              ? null
              : () async {
                  setState(() => _busy = true);
                  try {
                    await widget.onConfirm();
                    if (context.mounted) Navigator.pop(context, true);
                  } catch (e) {
                    if (context.mounted) {
                      Navigator.pop(context, false);
                      await showError(context, e, title: 'Démarrage refusé');
                    }
                  }
                },
          icon: _busy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Icon(Icons.play_arrow),
          label: const Text('CONFIRMER ET DÉMARRER'),
        ),
      ],
    );
  }
}
