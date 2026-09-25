import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api.dart';

/// État global léger : session et connexion WhatsApp active (pour la bannière de mode).
class AppState extends ChangeNotifier {
  bool loggedIn = api.hasToken;
  Map<String, dynamic>? user;
  Map<String, dynamic>? activeConnection;
  Timer? _timer;

  Future<void> login(String email, String password) async {
    final res = await api.post('/auth/login', {'email': email, 'password': password});
    await api.setToken(res['token'] as String);
    user = Map<String, dynamic>.from(res['user'] as Map);
    loggedIn = true;
    notifyListeners();
    unawaited(refreshConnection());
    _startTimer();
  }

  Future<void> restore() async {
    if (!api.hasToken) return;
    try {
      final me = await api.get('/auth/me');
      user = Map<String, dynamic>.from(me['user'] as Map);
      loggedIn = true;
      _startTimer();
      await refreshConnection();
    } catch (_) {
      loggedIn = api.hasToken;
    }
    notifyListeners();
  }

  Future<void> logout() async {
    try {
      await api.post('/auth/logout');
    } catch (_) {}
    await api.setToken(null);
    onSessionExpired();
  }

  void onSessionExpired() {
    loggedIn = false;
    user = null;
    activeConnection = null;
    _timer?.cancel();
    notifyListeners();
  }

  void _startTimer() {
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 45), (_) => refreshConnection());
  }

  Future<void> refreshConnection() async {
    try {
      final list = (await api.get('/connections')) as List;
      activeConnection = list.cast<Map>().map((e) => Map<String, dynamic>.from(e)).where((c) => c['isActive'] == true).firstOrNull;
      notifyListeners();
    } catch (_) {}
  }

  bool get isTestMode => activeConnection?['mode'] == 'TEST';

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}
