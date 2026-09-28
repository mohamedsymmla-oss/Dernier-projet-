import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../core/app_state.dart';
import '../core/theme.dart';

class NavItem {
  const NavItem(this.path, this.label, this.icon);
  final String path;
  final String label;
  final IconData icon;
}

const navItems = [
  NavItem('/', 'Accueil', Icons.dashboard_outlined),
  NavItem('/connexion', 'Connexion WhatsApp', Icons.link),
  NavItem('/automation1', 'Automation 1', Icons.looks_one_outlined),
  NavItem('/automation2', 'Automation 2', Icons.looks_two_outlined),
  NavItem('/qr/connexion', 'Connexion QR', Icons.qr_code_2),
  NavItem('/qr/automation1', 'QR · Automation 1', Icons.filter_1),
  NavItem('/qr/automation2', 'QR · Automation 2', Icons.filter_2),
  NavItem('/contacts', 'Contacts', Icons.people_outline),
  NavItem('/medias', 'Médias', Icons.perm_media_outlined),
  NavItem('/historique', 'Historique', Icons.history),
  NavItem('/logs', 'Logs', Icons.terminal),
  NavItem('/reglages', 'Réglages', Icons.settings_outlined),
];

/// Navigation principale : barre latérale sur grand écran, menu tiroir sur téléphone.
class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.location, required this.child});
  final String location;
  final Widget child;

  int get _index {
    var best = 0;
    var bestLen = 0;
    for (var i = 0; i < navItems.length; i++) {
      final p = navItems[i].path;
      if (p != '/' && location.startsWith(p) && p.length > bestLen) {
        best = i;
        bestLen = p.length;
      }
    }
    return best;
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final wide = MediaQuery.sizeOf(context).width >= 900;
    final current = navItems[_index];
    final banner = state.isTestMode
        ? MaterialBanner(
            backgroundColor: StatusColors.warning.withValues(alpha: 0.15),
            leading: const Icon(Icons.science_outlined, color: StatusColors.warning),
            content: const Text('MODE TEST — les envois utilisent la connexion de test ; données séparées de la production.',
                style: TextStyle(fontWeight: FontWeight.w700)),
            actions: const [SizedBox.shrink()],
          )
        : null;

    final qrAlert = state.qrAlert;
    final qrBanner = qrAlert == null
        ? null
        : MaterialBanner(
            backgroundColor: StatusColors.error.withValues(alpha: 0.12),
            leading: const Icon(Icons.qr_code_2, color: StatusColors.error),
            content: Text(qrAlert, style: const TextStyle(fontWeight: FontWeight.w700)),
            actions: [TextButton(onPressed: () => context.go('/qr/connexion'), child: const Text('Ouvrir'))],
          );
    final body = Column(children: [?banner, ?qrBanner, Expanded(child: child)]);

    if (wide) {
      return Scaffold(
        body: Row(children: [
          NavigationRail(
            extended: MediaQuery.sizeOf(context).width >= 1200,
            selectedIndex: _index,
            onDestinationSelected: (i) => context.go(navItems[i].path),
            leading: Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Icon(Icons.chat, color: Theme.of(context).colorScheme.primary, size: 30),
            ),
            destinations: [
              for (final n in navItems) NavigationRailDestination(icon: Icon(n.icon), label: Text(n.label)),
            ],
          ),
          const VerticalDivider(width: 1),
          Expanded(
            child: Scaffold(appBar: AppBar(title: Text(current.label), actions: _modeChip(state)), body: body),
          ),
        ]),
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(current.label), actions: _modeChip(state)),
      drawer: NavigationDrawer(
        selectedIndex: _index,
        onDestinationSelected: (i) {
          Navigator.pop(context);
          context.go(navItems[i].path);
        },
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(28, 20, 16, 12),
            child: Row(children: [
              Icon(Icons.chat, color: Theme.of(context).colorScheme.primary),
              const SizedBox(width: 10),
              const Text('WA Automation', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
            ]),
          ),
          for (final n in navItems) NavigationDrawerDestination(icon: Icon(n.icon), label: Text(n.label)),
        ],
      ),
      body: body,
    );
  }

  List<Widget> _modeChip(AppState s) {
    final c = s.activeConnection;
    if (c == null) return const [];
    final test = c['mode'] == 'TEST';
    return [
      Padding(
        padding: const EdgeInsets.only(right: 12),
        child: Chip(
          visualDensity: VisualDensity.compact,
          avatar: Icon(test ? Icons.science : Icons.verified, size: 16, color: test ? StatusColors.warning : StatusColors.ok),
          label: Text(test ? 'TEST' : 'PRODUCTION', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12)),
        ),
      ),
    ];
  }
}
