import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api.dart';
import '../core/app_state.dart';
import '../widgets/common.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  int _refresh = 0;

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    return AsyncView<Map>(
      refreshKey: _refresh,
      load: () async => await api.get('/settings') as Map,
      builder: (context, s, reload) {
        final server = s['server'] as Map;
        return PageBody(onRefresh: reload, children: [
          SectionCard(
            title: 'NUMÉRO DE TEST',
            icon: Icons.phone_android,
            subtitle: 'Seul destinataire des boutons « Tester »',
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              InfoRow('Numéro', s['testPhone'] as String? ?? 'Non défini'),
              Align(
                alignment: Alignment.centerLeft,
                child: BusyButton(
                  label: 'Modifier',
                  icon: Icons.edit,
                  outlined: true,
                  onPressed: () async {
                    final v = await promptText(context, title: 'Numéro de test', label: 'Ex : +223 76 12 34 56', initial: s['testPhone'] as String? ?? '', keyboard: TextInputType.phone);
                    if (v == null || !context.mounted) return;
                    await runAction(context, () => api.put('/settings/test-phone', {'phone': v.isEmpty ? null : v}), success: 'Numéro de test enregistré');
                    setState(() => _refresh++);
                  },
                ),
              ),
            ]),
          ),
          SectionCard(
            title: 'Pays par défaut',
            icon: Icons.flag_outlined,
            subtitle: 'Utilisé pour les numéros importés sans indicatif',
            child: Row(children: [
              Expanded(child: Text('${s['defaultCountry']}', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 18))),
              OutlinedButton(
                onPressed: () async {
                  final v = await promptText(context, title: 'Code pays (ISO, 2 lettres)', hint: 'ML, SN, CI, FR…', initial: '${s['defaultCountry']}');
                  if (v == null || v.length != 2 || !context.mounted) return;
                  await runAction(context, () => api.put('/settings/default-country', {'country': v}), success: 'Pays enregistré');
                  setState(() => _refresh++);
                },
                child: const Text('Modifier'),
              ),
            ]),
          ),
          SectionCard(
            title: 'Serveur',
            icon: Icons.dns_outlined,
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              InfoRow('URL du backend', api.baseUrl, copyable: true),
              InfoRow('URL publique', server['publicBackendUrl'] as String? ?? 'Non définie'),
              InfoRow('Stockage médias', '${server['storage']}'),
              InfoRow('FFmpeg', server['ffmpegAvailable'] == true ? 'Disponible' : 'Non installé'),
              InfoRow('Concurrence A1', '${server['a1Concurrency']} contacts en parallèle'),
              InfoRow('Débit max', '${server['maxMessagesPerSecond']} messages / seconde'),
              InfoRow('Tentatives max', '${server['maxAttempts']}'),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerLeft,
                child: OutlinedButton.icon(
                  icon: const Icon(Icons.edit),
                  label: const Text('Changer l’URL du backend'),
                  onPressed: () async {
                    final v = await promptText(context, title: 'URL du backend', initial: api.baseUrl, keyboard: TextInputType.url);
                    if (v == null || v.isEmpty || !context.mounted) return;
                    await api.setBaseUrl(v);
                    if (context.mounted) await context.read<AppState>().logout();
                  },
                ),
              ),
            ]),
          ),
          SectionCard(
            title: 'Session',
            icon: Icons.account_circle_outlined,
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              InfoRow('Compte', state.user?['email'] as String?),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerLeft,
                child: FilledButton.tonalIcon(
                  onPressed: () => context.read<AppState>().logout(),
                  icon: const Icon(Icons.logout),
                  label: const Text('Se déconnecter'),
                ),
              ),
            ]),
          ),
          const Text(
            'Les automatisations tournent sur le serveur : vous pouvez fermer l’application ou éteindre le téléphone. '
            'Aucune clé API n’est stockée dans l’application.',
            textAlign: TextAlign.center,
          ),
        ]);
      },
    );
  }
}
