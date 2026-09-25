import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../widgets/common.dart';
import '../widgets/media_widgets.dart';

class MediaScreen extends StatefulWidget {
  const MediaScreen({super.key});

  @override
  State<MediaScreen> createState() => _MediaScreenState();
}

class _MediaScreenState extends State<MediaScreen> {
  int _refresh = 0;

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Column(children: [
        const TabBar(tabs: [Tab(icon: Icon(Icons.audiotrack), text: 'Audios'), Tab(icon: Icon(Icons.image), text: 'Images')]),
        Expanded(
          child: AsyncView<Map>(
            refreshKey: _refresh,
            load: () async => {
              'items': await api.get('/media'),
              'caps': await api.get('/media/capabilities'),
            },
            builder: (context, d, reload) {
              final items = (d['items'] as List).cast<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
              final caps = d['caps'] as Map;
              return TabBarView(children: [
                for (final kind in ['audio', 'image'])
                  PageBody(onRefresh: reload, children: [
                    if (caps['uploadAvailable'] != true)
                      SectionCard(
                        title: 'Import de fichiers : à configurer',
                        icon: Icons.cloud_off,
                        child: Text('${caps['storage']}. Les URL publiques restent utilisables.'),
                      ),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: BusyButton(
                        label: kind == 'audio' ? 'Ajouter un audio' : 'Ajouter une image',
                        icon: Icons.add,
                        onPressed: () async {
                          final m = await pickNewMedia(context, kind: kind);
                          if (m != null) setState(() => _refresh++);
                        },
                      ),
                    ),
                    if (items.where((m) => m['kind'] == kind).isEmpty)
                      const EmptyState(icon: Icons.perm_media_outlined, message: 'Aucun média'),
                    ResponsiveGrid(minItemWidth: 320, children: [
                      for (final m in items.where((m) => m['kind'] == kind))
                        _MediaCard(media: m, ffmpeg: caps['ffmpegAvailable'] == true, onChanged: () => setState(() => _refresh++)),
                    ]),
                  ]),
              ]);
            },
          ),
        ),
      ]),
    );
  }
}

class _MediaCard extends StatelessWidget {
  const _MediaCard({required this.media, required this.ffmpeg, required this.onChanged});
  final Map<String, dynamic> media;
  final bool ffmpeg;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final m = media;
    final used = (m['usedIn'] as List?)?.cast<String>() ?? const [];
    final validation = m['validation'] as Map?;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (m['kind'] == 'image')
          AspectRatio(
            aspectRatio: 16 / 9,
            child: m['previewUrl'] == null
                ? const ColoredBox(color: Colors.black12, child: Icon(Icons.image_not_supported))
                : Image.network(m['previewUrl'] as String, fit: BoxFit.cover, errorBuilder: (_, _, _) => const Icon(Icons.broken_image)),
          ),
        Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('${m['name']}', style: const TextStyle(fontWeight: FontWeight.w700), overflow: TextOverflow.ellipsis),
            Text(mediaSubtitle(m), style: Theme.of(context).textTheme.bodySmall),
            Text('Ajouté le ${fmtDateTime(m['createdAt'])}', style: Theme.of(context).textTheme.bodySmall),
            if (m['kind'] == 'audio') ...[
              const SizedBox(height: 6),
              AudioPreview(url: m['previewUrl'] as String?),
              if (validation?['isOggOpus'] == true)
                const Padding(
                  padding: EdgeInsets.only(top: 4),
                  child: StatusBadge('OGG/Opus (format des notes vocales) — n’implique pas un envoi en message vocal', tone: Tone.info, dense: true),
                ),
            ],
            const SizedBox(height: 8),
            Wrap(spacing: 6, runSpacing: 6, children: [
              StatusBadge(m['status'] == 'VALID' ? 'Vérifié' : 'Invalide', tone: m['status'] == 'VALID' ? Tone.ok : Tone.error, dense: true),
              if (used.isEmpty) const StatusBadge('Non utilisé', tone: Tone.inactive, dense: true),
              for (final u in used) StatusBadge(u, tone: Tone.info, dense: true),
            ]),
            if (validation?['checks'] is List)
              ExpansionTile(
                tilePadding: EdgeInsets.zero,
                title: const Text('Vérifications', style: TextStyle(fontSize: 13)),
                children: [
                  for (final c in (validation!['checks'] as List).cast<Map>())
                    ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(c['ok'] == true ? Icons.check : Icons.close, color: c['ok'] == true ? StatusColors.ok : StatusColors.error, size: 18),
                      title: Text('${c['label']}'),
                      subtitle: Text('${c['detail']}'),
                    ),
                ],
              ),
            const SizedBox(height: 6),
            Wrap(spacing: 6, runSpacing: 6, children: [
              BusyButton(label: 'Tester', icon: Icons.send_to_mobile, outlined: true, onPressed: () => testMediaOnTestNumber(context, m['id'] as String)),
              BusyButton(
                label: 'Remplacer',
                icon: Icons.swap_horiz,
                outlined: true,
                onPressed: () async {
                  final nm = await pickNewMedia(context, kind: m['kind'] as String);
                  if (nm == null || !context.mounted) return;
                  await runAction(context, () => api.post('/media/${m['id']}/replace', {'newMediaId': nm['id']}),
                      success: 'Remplacé partout où il était utilisé');
                  onChanged();
                },
              ),
              if (m['kind'] == 'audio' && ffmpeg && validation?['isOggOpus'] != true)
                BusyButton(
                  label: 'Convertir OGG/Opus',
                  icon: Icons.transform,
                  outlined: true,
                  onPressed: () async {
                    await runAction(context, () => api.post('/media/${m['id']}/convert'), success: 'Copie OGG/Opus créée');
                    onChanged();
                  },
                ),
              BusyButton(
                label: 'Supprimer',
                icon: Icons.delete_outline,
                outlined: true,
                color: StatusColors.error,
                onPressed: () => _delete(context),
              ),
            ]),
          ]),
        ),
      ]),
    );
  }

  Future<void> _delete(BuildContext context) async {
    if (!await confirm(context, title: 'Supprimer ce média ?', message: '${media['name']}', ok: 'Supprimer', danger: true)) return;
    try {
      await api.delete('/media/${media['id']}');
      onChanged();
    } on ApiException catch (e) {
      if (!context.mounted) return;
      if (e.statusCode == 409 && !e.message.contains('campagne en cours')) {
        final force = await confirm(context,
            title: 'Média utilisé',
            message: '${e.message}\n\n${(e.details as List?)?.join('\n') ?? ''}\n\nIl sera retiré de ces réglages (les autres réglages ne changent pas).',
            ok: 'Supprimer quand même',
            danger: true);
        if (force && context.mounted) {
          await runAction(context, () => api.delete('/media/${media['id']}', query: {'force': true}), success: 'Média supprimé');
          onChanged();
        }
      } else {
        await showError(context, e);
      }
    }
  }
}
