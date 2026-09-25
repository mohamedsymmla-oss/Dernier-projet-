import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:provider/provider.dart';

import 'core/api.dart';
import 'core/app_state.dart';
import 'core/theme.dart';
import 'screens/automation1_screen.dart';
import 'screens/automation2_screen.dart';
import 'screens/connection_screen.dart';
import 'screens/contacts_screen.dart';
import 'screens/dashboard_screen.dart';
import 'screens/history_screen.dart';
import 'screens/login_screen.dart';
import 'screens/logs_screen.dart';
import 'screens/media_screen.dart';
import 'screens/settings_screen.dart';
import 'screens/shell.dart';
import 'screens/timeline_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initializeDateFormatting('fr_FR');
  await api.init();
  final state = AppState();
  api.onUnauthorized = state.onSessionExpired;
  await state.restore();
  runApp(ChangeNotifierProvider.value(value: state, child: WaApp(state: state)));
}

class WaApp extends StatefulWidget {
  const WaApp({super.key, required this.state});
  final AppState state;

  @override
  State<WaApp> createState() => _WaAppState();
}

class _WaAppState extends State<WaApp> {
  late final GoRouter _router = GoRouter(
    initialLocation: '/',
    refreshListenable: widget.state,
    redirect: (context, s) {
      final logged = widget.state.loggedIn;
      if (!logged && s.matchedLocation != '/login') return '/login';
      if (logged && s.matchedLocation == '/login') return '/';
      return null;
    },
    routes: [
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      ShellRoute(
        builder: (context, state, child) => AppShell(location: state.matchedLocation, child: child),
        routes: [
          GoRoute(path: '/', builder: (_, _) => const DashboardScreen()),
          GoRoute(path: '/connexion', builder: (_, _) => const ConnectionScreen()),
          GoRoute(path: '/automation1', builder: (_, _) => const Automation1Screen()),
          GoRoute(path: '/automation2', builder: (_, _) => const Automation2Screen()),
          GoRoute(path: '/contacts', builder: (_, _) => const ContactsScreen()),
          GoRoute(path: '/contacts/:id', builder: (_, s) => TimelineScreen(contactId: s.pathParameters['id']!)),
          GoRoute(path: '/medias', builder: (_, _) => const MediaScreen()),
          GoRoute(path: '/historique', builder: (_, _) => const HistoryScreen()),
          GoRoute(path: '/logs', builder: (_, _) => const LogsScreen()),
          GoRoute(path: '/reglages', builder: (_, _) => const SettingsScreen()),
        ],
      ),
    ],
  );

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'WA Automation',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      locale: const Locale('fr', 'FR'),
      supportedLocales: const [Locale('fr', 'FR')],
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      routerConfig: _router,
    );
  }
}
