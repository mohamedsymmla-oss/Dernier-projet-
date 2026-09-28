import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import 'common.dart';
import 'delay_picker.dart';

/// Minuterie entre deux contacts : enregistrée en base et respectée par le worker du serveur.
/// Changer le délai ne modifie rien d'autre (ni médias, ni textes, ni l'autre canal).
class DelayCard extends StatefulWidget {
  const DelayCard({super.key, required this.type, required this.initial, required this.onSaved, this.channel = kProvider, this.subtitle});
  final String type;
  final String channel;
  final int initial;
  final VoidCallback onSaved;
  final String? subtitle;

  @override
  State<DelayCard> createState() => _DelayCardState();
}

class _DelayCardState extends State<DelayCard> {
  late int _value = widget.initial;
  late int _saved = widget.initial;

  @override
  Widget build(BuildContext context) {
    final dirty = _value != _saved;
    return SectionCard(
      title: 'MINUTERIE ENTRE DEUX CONTACTS',
      icon: Icons.timer_outlined,
      subtitle: widget.subtitle ?? 'De 1 seconde à 2 minutes — appliqué par le serveur',
      trailing: dirty
          ? const StatusBadge('Non enregistré', tone: Tone.warning, dense: true)
          : StatusBadge('Enregistré : ${fmtDelay(_saved)}', tone: Tone.ok, dense: true),
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
                    final r = await runAction(context, () => api.put(ch('/automations/${widget.type}/delay', widget.channel), {'seconds': _value}),
                        success: 'Délai enregistré : ${fmtDelay(_value)}');
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

/// Bandeau rappelant que l'écran concerne la partie WhatsApp QR, séparée du fournisseur.
class ChannelBanner extends StatelessWidget {
  const ChannelBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: c.tertiaryContainer, borderRadius: BorderRadius.circular(14)),
      child: Row(children: [
        Icon(Icons.qr_code_2, color: c.onTertiaryContainer),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            'Partie WhatsApp QR — réglages, listes et campagnes séparés de la partie fournisseur. '
            'Protection du numéro active : un contact à la fois, plafond quotidien, heures calmes.',
            style: TextStyle(color: c.onTertiaryContainer, fontWeight: FontWeight.w600),
          ),
        ),
      ]),
    );
  }
}
