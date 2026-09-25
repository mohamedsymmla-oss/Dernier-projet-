import 'package:audioplayers/audioplayers.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import 'common.dart';

/// Lecteur audio simple (lecture/pause) à partir de l'URL fournie par le backend.
class AudioPreview extends StatefulWidget {
  const AudioPreview({super.key, required this.url});
  final String? url;

  @override
  State<AudioPreview> createState() => _AudioPreviewState();
}

class _AudioPreviewState extends State<AudioPreview> {
  final _player = AudioPlayer();
  bool _playing = false;
  Duration _pos = Duration.zero;
  Duration _dur = Duration.zero;

  @override
  void initState() {
    super.initState();
    _player.onPlayerStateChanged.listen((s) {
      if (mounted) setState(() => _playing = s == PlayerState.playing);
    });
    _player.onPositionChanged.listen((p) {
      if (mounted) setState(() => _pos = p);
    });
    _player.onDurationChanged.listen((d) {
      if (mounted) setState(() => _dur = d);
    });
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  Future<void> _toggle() async {
    if (widget.url == null) return;
    try {
      if (_playing) {
        await _player.pause();
      } else {
        await _player.play(UrlSource(widget.url!));
      }
    } catch (e) {
      if (mounted) showSnack(context, 'Lecture impossible : $e', error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final total = _dur.inMilliseconds == 0 ? 1 : _dur.inMilliseconds;
    return Row(children: [
      IconButton.filledTonal(
        onPressed: widget.url == null ? null : _toggle,
        tooltip: _playing ? 'Pause' : 'Lire',
        icon: Icon(_playing ? Icons.pause : Icons.play_arrow),
      ),
      const SizedBox(width: 8),
      Expanded(child: LinearProgressIndicator(value: _pos.inMilliseconds / total, minHeight: 4, borderRadius: BorderRadius.circular(4))),
      const SizedBox(width: 8),
      Text('${fmtDurationMs(_pos.inMilliseconds)} / ${fmtDurationMs(_dur.inMilliseconds)}', style: const TextStyle(fontSize: 12)),
    ]);
  }
}

/// Choix d'un nouveau média : import de fichier ou URL publique. Renvoie le média créé par le backend.
Future<Map<String, dynamic>?> pickNewMedia(BuildContext context, {required String kind}) async {
  final choice = await showModalBottomSheet<String>(
    context: context,
    showDragHandle: true,
    builder: (ctx) => SafeArea(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        ListTile(
          leading: const Icon(Icons.upload_file),
          title: const Text('Importer un fichier'),
          subtitle: Text(kind == 'audio' ? 'MP3, OGG/Opus, M4A, AAC, AMR — 16 Mo max' : 'JPEG ou PNG — 5 Mo max'),
          onTap: () => Navigator.pop(ctx, 'file'),
        ),
        ListTile(
          leading: const Icon(Icons.link),
          title: const Text('URL publique'),
          subtitle: const Text('Lien https direct vers le fichier'),
          onTap: () => Navigator.pop(ctx, 'url'),
        ),
      ]),
    ),
  );
  if (choice == null || !context.mounted) return null;
  if (choice == 'url') {
    final url = await promptText(context, title: 'URL publique', label: 'https://…', keyboard: TextInputType.url);
    if (url == null || url.isEmpty || !context.mounted) return null;
    return _withProgress(context, 'Vérification de l’URL…', () async {
      return Map<String, dynamic>.from(await api.post('/media/url', {'kind': kind, 'url': url}) as Map);
    });
  }
  final file = await FilePicker.pickFile(
    type: FileType.custom,
    allowedExtensions: kind == 'audio' ? ['mp3', 'ogg', 'opus', 'm4a', 'aac', 'amr'] : ['jpg', 'jpeg', 'png'],
  );
  if (file == null || !context.mounted) return null;
  return _withProgress(context, 'Import et vérification du fichier…', () async {
    final bytes = await file.readAsBytes();
    return Map<String, dynamic>.from(
        await api.upload('/media/upload', bytes: bytes, filename: file.name, fields: {'kind': kind}) as Map);
  });
}

Future<T?> _withProgress<T>(BuildContext context, String label, Future<T> Function() fn) async {
  showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (_) => AlertDialog(content: Row(children: [const CircularProgressIndicator(), const SizedBox(width: 16), Expanded(child: Text(label))])),
  );
  try {
    final r = await fn();
    if (context.mounted) Navigator.of(context, rootNavigator: true).pop();
    return r;
  } catch (e) {
    if (context.mounted) {
      Navigator.of(context, rootNavigator: true).pop();
      await showError(context, e, title: 'Média refusé');
    }
    return null;
  }
}

/// Envoie le média seul au numéro de test et affiche le résultat réel.
Future<void> testMediaOnTestNumber(BuildContext context, String mediaId) async {
  final r = await runAction(context, () async => Map<String, dynamic>.from(await api.post('/media/$mediaId/test') as Map));
  if (r == null || !context.mounted) return;
  await showDialog<void>(
    context: context,
    builder: (ctx) => AlertDialog(
      icon: Icon(r['ok'] == true ? Icons.check_circle : Icons.error, color: r['ok'] == true ? StatusColors.ok : StatusColors.error),
      title: Text(r['ok'] == true ? "Accepté par l'API" : 'Échec de l’envoi'),
      content: Text([
        'Destinataire : ${r['to']}',
        if (r['ok'] == true) 'Identifiant : ${r['providerMessageId']}' else 'Erreur : ${r['error']}',
        '',
        '${r['note']}',
        if (r['ok'] == true) "La livraison sera confirmée par webhook (voir Historique).",
      ].join('\n')),
      actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
    ),
  );
}

String mediaSubtitle(Map m) {
  final parts = <String>[
    (m['extension'] ?? m['mime'] ?? '?').toString().toUpperCase(),
    fmtBytes(m['sizeBytes'] as num?),
    if (m['kind'] == 'audio') fmtDurationMs(m['durationMs'] as num?),
    if (m['kind'] == 'image' && m['width'] != null) '${m['width']}×${m['height']}',
    m['source'] == 'url' ? 'URL publique' : 'Fichier',
  ];
  return parts.join(' • ');
}

/// Zone audio d'une automatisation (Importer / URL, Lire, Tester, Remplacer, Supprimer).
class AudioSlot extends StatelessWidget {
  const AudioSlot({super.key, required this.title, required this.media, required this.onSet, this.voiceNoteSupported = false});
  final String title;
  final Map<String, dynamic>? media;
  final Future<void> Function(String? mediaId) onSet;
  final bool voiceNoteSupported;

  @override
  Widget build(BuildContext context) {
    final m = media;
    return SectionCard(
      title: title,
      icon: Icons.graphic_eq,
      trailing: StatusBadge(voiceNoteSupported ? 'Message vocal' : 'Audio standard',
          tone: voiceNoteSupported ? Tone.ok : Tone.info, icon: Icons.info_outline, dense: true),
      child: m == null
          ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const Text('Aucun audio configuré.'),
              const SizedBox(height: 10),
              Wrap(spacing: 8, runSpacing: 8, children: [
                BusyButton(
                  label: 'Importer fichier / URL',
                  icon: Icons.add,
                  onPressed: () async {
                    final nm = await pickNewMedia(context, kind: 'audio');
                    if (nm != null) await onSet(nm['id'] as String);
                  },
                ),
              ]),
            ])
          : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Row(children: [
                const Icon(Icons.audio_file, size: 30),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('${m['name']}', style: const TextStyle(fontWeight: FontWeight.w700)),
                    Text(mediaSubtitle(m), style: Theme.of(context).textTheme.bodySmall),
                  ]),
                ),
                StatusBadge(m['status'] == 'VALID' ? 'Valide' : 'Invalide', tone: m['status'] == 'VALID' ? Tone.ok : Tone.error, dense: true),
              ]),
              const SizedBox(height: 8),
              AudioPreview(url: m['previewUrl'] as String?),
              if (!voiceNoteSupported)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    "Le fournisseur n'offre pas le message vocal (PTT) : l'audio sera reçu comme un fichier audio standard. "
                    'Utilisez « Tester » pour vérifier sur votre téléphone.',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              const SizedBox(height: 10),
              Wrap(spacing: 8, runSpacing: 8, children: [
                BusyButton(label: 'Tester', icon: Icons.send_to_mobile, outlined: true, onPressed: () => testMediaOnTestNumber(context, m['id'] as String)),
                BusyButton(
                  label: 'Remplacer',
                  icon: Icons.swap_horiz,
                  outlined: true,
                  onPressed: () async {
                    final nm = await pickNewMedia(context, kind: 'audio');
                    if (nm != null) await onSet(nm['id'] as String);
                  },
                ),
                BusyButton(
                  label: 'Retirer',
                  icon: Icons.delete_outline,
                  outlined: true,
                  color: StatusColors.error,
                  onPressed: () async {
                    if (await confirm(context, title: 'Retirer l’audio ?', message: 'Le fichier reste disponible dans la bibliothèque médias.')) {
                      await onSet(null);
                    }
                  },
                ),
              ]),
            ]),
    );
  }
}
