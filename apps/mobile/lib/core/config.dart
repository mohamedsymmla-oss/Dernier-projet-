import 'package:shared_preferences/shared_preferences.dart';

/// URL du backend.
/// Priorité : valeur saisie dans l'application > --dart-define=BACKEND_URL=... > valeur par défaut.
/// Aucune clé API ni secret n'est stocké dans l'application : uniquement l'URL du serveur.
class AppConfig {
  static const String compiledBackendUrl = String.fromEnvironment(
    'BACKEND_URL',
    defaultValue: 'http://10.0.2.2:3000',
  );
  static const _key = 'backend_url';

  static Future<String> backendUrl() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getString(_key);
      if (saved != null && saved.trim().isNotEmpty) return _clean(saved);
    } catch (_) {}
    return _clean(compiledBackendUrl);
  }

  static Future<void> setBackendUrl(String? url) async {
    final prefs = await SharedPreferences.getInstance();
    if (url == null || url.trim().isEmpty) {
      await prefs.remove(_key);
    } else {
      await prefs.setString(_key, _clean(url));
    }
  }

  static String _clean(String url) => url.trim().replaceAll(RegExp(r'/+$'), '');
}
