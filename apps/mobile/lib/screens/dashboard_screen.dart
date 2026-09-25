import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../widgets/common.dart';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  int _tick = 0;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 10), (_) => setState(() => _tick++));
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AsyncView<Map<String, dynamic>>(
      refreshKey: _tick,
      load: () async => Map<String, dynamic>.from(await api.get('/dashboard') as Map),
      builder: (context, d, reload) {
        final wa = Map<String, dynamic>.from(d['whatsapp'] as Map);
        final provider = d['provider'] as Map?;
        final webhook = d['webhook'] as Map?;
        final a1 = d['automation1'] as Map;
        final a2 = d['automation2'] as Map?;
        final waStatus = wa['status'] as String;
        final waTone = switch (waStatus) { 'CONNECTED' => Tone.ok, 'NOT_CONFIGURED' => Tone.inactive, 'ERROR' => Tone.error, _ => Tone.warning };
        final waLabel = switch (waStatus) {
          'CONNECTED' => 'Connecté',
          'NOT_CONFIGURED' => 'À configurer',
          'ERROR' => 'Erreur',
          'DISCONNECTED' => 'Déconnecté',
          _ => 'Non vérifié',
        };
        final whTone = switch (webhook?['status']) { 'ok' => Tone.ok, 'warning' => Tone.warning, _ => Tone.inactive };
        final whLabel = switch (webhook?['status']) {
          'ok' => 'Fonctionnel',
          'warning' => 'Rien reçu récemment',
          _ => webhook == null ? 'À configurer' : 'Aucun webhook reçu',
        };
        return PageBody(onRefresh: reload, children: [
          ResponsiveGrid(minItemWidth: 230, children: [
            _Card(
              title: 'WhatsApp',
              icon: Icons.chat_bubble_outline,
              badge: StatusBadge(waLabel, tone: waTone),
              lines: [wa['phoneNumber'] as String? ?? 'Aucun numéro', if (wa['mode'] != null) 'Mode ${wa['mode']}'],
              onTap: () => context.go('/connexion'),
            ),
            _Card(
              title: 'Fournisseur',
              icon: Icons.hub_outlined,
              badge: StatusBadge(provider == null ? 'À configurer' : (provider['apiOk'] == true ? 'API OK' : 'API non vérifiée'),
                  tone: provider == null ? Tone.inactive : (provider['apiOk'] == true ? Tone.ok : Tone.warning)),
              lines: [provider?['name'] as String? ?? '—', 'Dernier test : ${fmtAgo(provider?['lastTestAt'])}'],
              onTap: () => context.go('/connexion'),
            ),
            _Card(
              title: 'Webhook',
              icon: Icons.webhook,
              badge: StatusBadge(whLabel, tone: whTone),
              lines: ['Dernier reçu : ${fmtAgo(webhook?['lastAt'])}', if (webhook?['verified'] == true) 'Signature vérifiée'],
              onTap: () => context.go('/logs'),
            ),
            _Card(
              title: 'Automation 1',
              icon: Icons.looks_one_outlined,
              value: '${a1['completed']}',
              lines: ['terminés sur ${a1['total']} destinataires'],
              onTap: () => context.go('/automation1'),
            ),
            _Card(
              title: 'Automation 2',
              icon: Icons.looks_two_outlined,
              value: a2 == null ? '—' : '${a2['done']} / ${a2['total']}',
              badge: a2 == null ? null : StatusBadge(runStatusLabels[a2['status']] ?? '${a2['status']}', tone: toneForRun(a2['status'] as String?), dense: true),
              lines: const ['dernière campagne'],
              onTap: () => context.go('/automation2'),
            ),
            _Card(
              title: 'Échecs',
              icon: Icons.error_outline,
              value: '${d['failures']}',
              valueColor: (d['failures'] as int) > 0 ? StatusColors.error : null,
              lines: const ['échecs, modèles requis, à vérifier'],
              onTap: () => context.go('/historique'),
            ),
            _Card(
              title: 'Réponses clients',
              icon: Icons.reply,
              value: '${d['responses']}',
              lines: const ['ont répondu après Automation 1'],
              onTap: () => context.go('/contacts'),
            ),
          ]),
          if ((d['activeRuns'] as List).isNotEmpty)
            SectionCard(
              title: 'Automatisations en cours',
              icon: Icons.play_circle_outline,
              child: Column(children: [
                for (final r in (d['activeRuns'] as List).cast<Map>())
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(r['automation_type'] == 'A1' ? Icons.looks_one : Icons.looks_two),
                    title: Text(r['automation_type'] == 'A1' ? 'Automation 1' : 'Automation 2'),
                    subtitle: Text(r['kind'] == 'TEMPLATE' ? 'Envoi de modèle WhatsApp' : 'Séquence'),
                    trailing: StatusBadge(runStatusLabels[r['status']] ?? '${r['status']}', tone: toneForRun(r['status'] as String?)),
                    onTap: () => context.go(r['automation_type'] == 'A1' ? '/automation1' : '/automation2'),
                  ),
              ]),
            ),
          ResponsiveGrid(minItemWidth: 380, children: [
            SectionCard(
              title: 'Dernières activités',
              icon: Icons.bolt,
              child: (d['recentActivity'] as List).isEmpty
                  ? const EmptyState(icon: Icons.inbox, message: 'Aucune activité')
                  : Column(children: [
                      for (final a in (d['recentActivity'] as List).cast<Map>())
                        ListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          title: Text(_actionLabel(a['action'] as String)),
                          subtitle: Text(fmtDateTime(a['created_at'])),
                        ),
                    ]),
            ),
            SectionCard(
              title: 'Dernières erreurs',
              icon: Icons.report_gmailerrorred,
              child: (d['recentErrors'] as List).isEmpty
                  ? const EmptyState(icon: Icons.check_circle_outline, message: 'Aucune erreur')
                  : Column(children: [
                      for (final e in (d['recentErrors'] as List).cast<Map>())
                        ListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          leading: const Icon(Icons.error, color: StatusColors.error, size: 18),
                          title: Text('${e['to_phone']} — ${e['kind']}'),
                          subtitle: Text('${e['error_message'] ?? e['error_code'] ?? ''}\n${fmtDateTime(e['at'])}'),
                          isThreeLine: true,
                          trailing: IconButton(
                            icon: const Icon(Icons.copy, size: 16),
                            onPressed: () => copyText(context, '${e['to_phone']} ${e['kind']} ${e['error_code']} ${e['error_message']}'),
                          ),
                        ),
                    ]),
            ),
          ]),
        ]);
      },
    );
  }

  String _actionLabel(String a) => const {
        'run.created': 'Campagne démarrée',
        'run.paused': 'Campagne mise en pause',
        'run.resumed': 'Campagne reprise',
        'run.stopped': 'Campagne arrêtée',
        'run.retry': 'Relance des échecs',
        'connection.created': 'Connexion ajoutée',
        'connection.updated': 'Connexion modifiée',
        'connection.disconnected': 'Connexion déconnectée',
        'connection.number_selected': 'Numéro WhatsApp sélectionné',
        'config.delay': 'Délai Automation 2 modifié',
        'config.audio': 'Audio modifié',
        'config.text1': 'Texte 1 modifié',
        'config.text2': 'Texte 2 modifié',
        'config.photos': 'Photos modifiées',
        'config.photo_count': 'Nombre de photos modifié',
        'media.uploaded': 'Média importé',
        'media.url_added': 'Média (URL) ajouté',
        'media.deleted': 'Média supprimé',
        'media.replaced': 'Média remplacé',
        'auth.login': 'Connexion à l’application',
        'auth.login_failed': 'Échec de connexion à l’application',
        'webhook.rejected': 'Webhook refusé (signature)',
        'preset.saved': 'Préset enregistré',
        'preset.applied': 'Préset appliqué',
      }[a] ??
      a;
}

class _Card extends StatelessWidget {
  const _Card({required this.title, required this.icon, this.badge, this.value, this.valueColor, this.lines = const [], this.onTap});
  final String title;
  final IconData icon;
  final Widget? badge;
  final String? value;
  final Color? valueColor;
  final List<String> lines;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(icon, size: 20, color: theme.colorScheme.primary),
              const SizedBox(width: 8),
              Expanded(child: Text(title, style: const TextStyle(fontWeight: FontWeight.w700))),
            ]),
            const SizedBox(height: 10),
            ?badge,
            if (value != null)
              Text(value!, style: theme.textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w800, color: valueColor)),
            const SizedBox(height: 6),
            for (final l in lines) Text(l, style: theme.textTheme.bodySmall, overflow: TextOverflow.ellipsis),
          ]),
        ),
      ),
    );
  }
}
