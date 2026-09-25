import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../widgets/common.dart';
import '../widgets/delay_picker.dart';
import '../widgets/import_flow.dart';
import '../widgets/media_widgets.dart';
import '../widgets/run_progress.dart';
import 'automation1_screen.dart';

class Automation2Screen extends StatefulWidget {
  const Automation2Screen({super.key});

  @override
  State<Automation2Screen> createState() => _Automation2ScreenState();
}

class _Automation2ScreenState extends State<Automation2Screen> {
  int _refresh = 0;

  Future<Map<String, dynamic>> _load() async {
    final cfg = Map<String, dynamic>.from(await api.get('/automations/A2/config') as Map);
    return {'cfg': cfg, 'voice': await voiceNoteSupported(), 'tpl': await templateRequiredCount('A2')};
  }

  void _reload() => setState(() => _refresh++);

  @override
  Widget build(BuildContext context) {
    return AsyncView<Map<String, dynamic>>(
      refreshKey: _refresh,
      load: _load,
      builder: (context, data, reload) {
        final cfg = data['cfg'] as Map<String, dynamic>;
        final photos = (cfg['photos'] as List).cast<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
        final count = cfg['photoCount'] as int;
        return PageBody(onRefresh: reload, children: [
          SectionCard(
            title: 'AUTOMATISATION 2',
            icon: Icons.looks_two_outlined,
            subtitle: 'Uniquement pour les personnes ayant répondu après Automation 1',
            trailing: IconButton(
              tooltip: 'Présets',
              icon: const Icon(Icons.bookmarks_outlined),
              onPressed: () => showPresetsSheet(context,
                  type: 'A2',
                  currentPayload: {
                    'audioMediaId': (cfg['audio'] as Map?)?['id'],
                    'photoMediaIds': photos.map((p) => p['id']).toList(),
                    'photoCount': count,
                    'delaySeconds': cfg['delaySeconds'],
                  },
                  onApplied: _reload),
            ),
            child: Text('Séquence : 1 audio puis $count photo(s). Les contacts sont traités un par un, '
                'avec ${fmtDelay(cfg['delaySeconds'] as int)} d’attente entre deux contacts.'),
          ),
          AudioSlot(
            title: 'AUDIO AUTOMATISATION 2',
            media: cfg['audio'] as Map<String, dynamic>?,
            voiceNoteSupported: data['voice'] as bool,
            onSet: (id) async {
              await runAction(context, () => api.put('/automations/A2/audio', {'mediaId': id}), success: 'Audio enregistré');
              _reload();
            },
          ),
          _PhotosCard(photos: photos, count: count, onChanged: _reload),
          _DelayCard(initial: cfg['delaySeconds'] as int, onSaved: _reload),
          SectionCard(
            title: 'Tester sur mon numéro',
            icon: Icons.send_to_mobile,
            subtitle: 'Audio + photos envoyés uniquement au numéro de test',
            child: Align(
              alignment: Alignment.centerLeft,
              child: BusyButton(label: 'TESTER LA SÉQUENCE', icon: Icons.play_circle_outline, onPressed: () => runSequenceTest(context, 'A2')),
            ),
          ),
          ImportPanel(
            automationType: 'A2',
            sequenceLabel: 'Audio + $count photo(s), un contact à la fois',
            allowResponders: true,
            onStarted: _reload,
          ),
          RunProgressCard(automationType: 'A2', refreshKey: _refresh),
          TemplateFollowupCard(automationType: 'A2', count: data['tpl'] as int, onStarted: _reload),
          WindowPolicyCard(type: 'A2', policy: cfg['windowPolicy'] as String, onChanged: _reload),
        ]);
      },
    );
  }
}

class _PhotosCard extends StatefulWidget {
  const _PhotosCard({required this.photos, required this.count, required this.onChanged});
  final List<Map<String, dynamic>> photos;
  final int count;
  final VoidCallback onChanged;

  @override
  State<_PhotosCard> createState() => _PhotosCardState();
}

class _PhotosCardState extends State<_PhotosCard> {
  late List<Map<String, dynamic>> _photos = [...widget.photos];

  @override
  void didUpdateWidget(covariant _PhotosCard old) {
    super.didUpdateWidget(old);
    _photos = [...widget.photos];
  }

  Future<void> _savePhotos(List<Map<String, dynamic>> list, {String? success}) async {
    final r = await runAction(context, () => api.put('/automations/A2/photos', {'mediaIds': list.map((p) => p['id']).toList()}), success: success);
    if (r != null) widget.onChanged();
  }

  Future<void> _setCount(int n) async {
    final r = await runAction(context, () => api.put('/automations/A2/photo-count', {'count': n}));
    if (r != null) widget.onChanged();
  }

  @override
  Widget build(BuildContext context) {
    final missing = widget.count > _photos.length;
    return SectionCard(
      title: 'PHOTOS (${_photos.length}/10)',
      icon: Icons.photo_library_outlined,
      subtitle: 'Glissez-déposez (appui long) pour changer l’ordre',
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          const Text('Nombre de photos à envoyer : '),
          const SizedBox(width: 8),
          DropdownButton<int>(
            value: widget.count,
            items: [for (var i = 1; i <= 10; i++) DropdownMenuItem(value: i, child: Text('$i'))],
            onChanged: (v) => v == null ? null : _setCount(v),
          ),
        ]),
        if (missing)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: StatusBadge('${widget.count} photos demandées mais ${_photos.length} configurée(s)', tone: Tone.warning, icon: Icons.warning_amber),
          ),
        const SizedBox(height: 8),
        ReorderableListView(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          buildDefaultDragHandles: false,
          onReorderItem: (oldIndex, newIndex) {
            setState(() {
              final item = _photos.removeAt(oldIndex);
              _photos.insert(newIndex, item);
            });
            _savePhotos(_photos, success: 'Ordre enregistré');
          },
          children: [
            for (var i = 0; i < _photos.length; i++)
              ReorderableDelayedDragStartListener(
                key: ValueKey(_photos[i]['id']),
                index: i,
                child: _PhotoTile(
                  index: i,
                  photo: _photos[i],
                  used: i < widget.count,
                  onReplace: () async {
                    final nm = await pickNewMedia(context, kind: 'image');
                    if (nm == null) return;
                    final list = [..._photos];
                    list[i] = nm;
                    await _savePhotos(list, success: 'Photo ${i + 1} remplacée');
                  },
                  onRemove: () async {
                    final list = [..._photos]..removeAt(i);
                    await _savePhotos(list, success: 'Photo retirée');
                  },
                ),
              ),
          ],
        ),
        if (_photos.length < 10)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: BusyButton(
              label: 'Ajouter la photo ${_photos.length + 1}',
              icon: Icons.add_photo_alternate_outlined,
              outlined: true,
              onPressed: () async {
                final nm = await pickNewMedia(context, kind: 'image');
                if (nm != null) await _savePhotos([..._photos, nm], success: 'Photo ajoutée');
              },
            ),
          ),
      ]),
    );
  }
}

class _PhotoTile extends StatelessWidget {
  const _PhotoTile({required this.index, required this.photo, required this.used, required this.onReplace, required this.onRemove});
  final int index;
  final Map<String, dynamic> photo;
  final bool used;
  final VoidCallback onReplace;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final url = photo['previewUrl'] as String?;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        leading: ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: SizedBox(
            width: 56,
            height: 56,
            child: url == null
                ? const Icon(Icons.broken_image)
                : Image.network(url, fit: BoxFit.cover, errorBuilder: (_, _, _) => const Icon(Icons.broken_image)),
          ),
        ),
        title: Text('Photo ${index + 1}', style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Text(photo['missing'] == true ? 'Média supprimé' : '${photo['name']}\n${mediaSubtitle(photo)}', maxLines: 2, overflow: TextOverflow.ellipsis),
        isThreeLine: true,
        trailing: Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: [
          if (!used) const StatusBadge('non envoyée', tone: Tone.inactive, dense: true),
          PopupMenuButton<String>(
            onSelected: (v) => v == 'replace' ? onReplace() : onRemove(),
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'replace', child: Text('Remplacer')),
              PopupMenuItem(value: 'remove', child: Text('Supprimer')),
            ],
          ),
          const Icon(Icons.drag_indicator),
        ]),
      ),
    );
  }
}

/// Minuterie : le réglage est enregistré en base (automation_configs.delay_between_contacts_seconds)
/// et respecté par le worker du serveur. Changer le délai ne modifie rien d'autre.
class _DelayCard extends StatefulWidget {
  const _DelayCard({required this.initial, required this.onSaved});
  final int initial;
  final VoidCallback onSaved;

  @override
  State<_DelayCard> createState() => _DelayCardState();
}

class _DelayCardState extends State<_DelayCard> {
  late int _value = widget.initial;
  late int _saved = widget.initial;

  @override
  Widget build(BuildContext context) {
    final dirty = _value != _saved;
    return SectionCard(
      title: 'MINUTERIE ENTRE DEUX CONTACTS',
      icon: Icons.timer_outlined,
      subtitle: 'De 1 seconde à 2 minutes — appliqué par le serveur',
      trailing: dirty ? const StatusBadge('Non enregistré', tone: Tone.warning, dense: true) : StatusBadge('Enregistré : ${fmtDelay(_saved)}', tone: Tone.ok, dense: true),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        DelayPicker(value: _value, onChanged: (v) => setState(() => _value = v)),
        const SizedBox(height: 14),
        Row(mainAxisAlignment: MainAxisAlignment.end, children: [
          if (dirty) TextButton(onPressed: () => setState(() => _value = _saved), child: const Text('Annuler')),
          const SizedBox(width: 8),
          BusyButton(
            label: 'Enregistrer',
            icon: Icons.save_outlined,
            onPressed: dirty
                ? () async {
                    final r = await runAction(context, () => api.put('/automations/A2/delay', {'seconds': _value}), success: 'Délai enregistré : ${fmtDelay(_value)}');
                    if (r != null) {
                      setState(() => _saved = _value);
                      widget.onSaved();
                    }
                  }
                : null,
          ),
        ]),
      ]),
    );
  }
}
