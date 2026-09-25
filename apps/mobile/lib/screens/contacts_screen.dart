import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../widgets/common.dart';

class ContactsScreen extends StatefulWidget {
  const ContactsScreen({super.key});

  @override
  State<ContactsScreen> createState() => _ContactsScreenState();
}

class _ContactsScreenState extends State<ContactsScreen> {
  final _q = TextEditingController();
  String? _filter;
  int _page = 1;
  int _refresh = 0;

  static const filters = {
    null: 'Tous',
    'responded': 'Ont répondu après A1',
    'a1_done': 'A1 terminée',
    'a1_none': 'Sans A1',
    'a2_done': 'A2 terminée',
    'template_required': 'Modèle requis',
    'errors': 'Avec erreur',
  };

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
        child: TextField(
          controller: _q,
          keyboardType: TextInputType.phone,
          decoration: InputDecoration(
            prefixIcon: const Icon(Icons.search),
            hintText: 'Rechercher un numéro',
            suffixIcon: IconButton(icon: const Icon(Icons.arrow_forward), onPressed: () => setState(() => _refresh++)),
          ),
          onSubmitted: (_) => setState(() {
            _page = 1;
            _refresh++;
          }),
        ),
      ),
      SizedBox(
        height: 48,
        child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 16), children: [
          for (final f in filters.entries)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: ChoiceChip(
                label: Text(f.value),
                selected: _filter == f.key,
                onSelected: (_) => setState(() {
                  _filter = f.key;
                  _page = 1;
                  _refresh++;
                }),
              ),
            ),
        ]),
      ),
      Expanded(
        child: AsyncView<Map>(
          refreshKey: _refresh,
          load: () async => await api.get('/contacts', query: {'q': _q.text, 'filter': _filter, 'page': _page, 'pageSize': 50}) as Map,
          builder: (context, d, reload) {
            final items = (d['items'] as List).cast<Map>();
            final total = d['total'] as int;
            if (items.isEmpty) return const EmptyState(icon: Icons.people_outline, message: 'Aucun contact');
            return RefreshIndicator(
              onRefresh: reload,
              child: ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 24), children: [
                Text('$total contact(s)', style: Theme.of(context).textTheme.bodySmall),
                const SizedBox(height: 6),
                for (final c in items)
                  Card(
                    margin: const EdgeInsets.only(bottom: 8),
                    child: ListTile(
                      onTap: () => context.go('/contacts/${c['id']}'),
                      title: Text('${c['phone_e164']}', style: const TextStyle(fontWeight: FontWeight.w700)),
                      subtitle: Text([
                        'Ajouté le ${fmtDate(c['created_at'])}',
                        if (c['last_inbound_at'] != null) 'Dernier message reçu ${fmtAgo(c['last_inbound_at'])}',
                        if (c['last_error'] != null) '⚠ ${c['last_error']}',
                      ].join('\n')),
                      isThreeLine: true,
                      trailing: Wrap(direction: Axis.vertical, spacing: 4, crossAxisAlignment: WrapCrossAlignment.end, children: [
                        _auto('A1', c['a1_status'] as String),
                        _auto('A2', c['a2_status'] as String),
                        if (c['responded_after_a1'] == true) const StatusBadge('A répondu', tone: Tone.ok, icon: Icons.reply, dense: true),
                      ]),
                    ),
                  ),
                Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  IconButton(onPressed: _page > 1 ? () => setState(() {
                    _page--;
                    _refresh++;
                  }) : null, icon: const Icon(Icons.chevron_left)),
                  Text('Page $_page / ${((total + 49) ~/ 50).clamp(1, 1 << 20)}'),
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

  Widget _auto(String label, String status) {
    if (status == 'NONE') return StatusBadge('$label : —', tone: Tone.inactive, dense: true);
    return StatusBadge('$label : ${recipientStatusLabels[status] ?? status}', tone: toneForRecipient(status), dense: true);
  }
}
