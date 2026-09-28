import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api.dart';

/// État global léger : session et connexion WhatsApp active (pour la bannière de mode).
class AppState extends ChangeNotifier {
  bool loggedIn = api.hasToken;
  Map<String, dynamic>? user;
  Map<String, dynamic>? activeConnection;
  Map<String, dynamic>? qrSession;
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
    qrSession = null;
    _timer?.cancel();
    notifyListeners();
  }

  void _startTimer() {
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 45), (_) {
      refreshConnection();
      refreshQr();
    });
    refreshQr();
  }

  Future<void> refreshQr() async {
    try {
      qrSession = Map<String, dynamic>.from(await api.get('/qr/session') as Map);
      notifyListeners();
    } catch (_) {}
  }

  /// Alerte affichée partout si la session QR (déjà utilisée) tombe, ou si l'arrêt d'urgence est actif.
  String? get qrAlert {
    final s = qrSession;
    if (s == null) return null;
    if ((s['safety'] as Map?)?['emergencyStopped'] == true) return 'WhatsApp QR : arrêt d’urgence actif, envois suspendus';
    final status = s['status'];
    final wasPaired = s['pairedAt'] != null;
    if (wasPaired && s['desiredState'] == 'RUNNING' && status != 'CONNECTED') return 'WhatsApp QR déconnecté : reconnexion en cours…';
    if (wasPaired && (status == 'LOGGED_OUT' || status == 'DISCONNECTED') && s['lastError'] != null && s['lastError'] != 'Déconnecté manuellement') {
      return 'WhatsApp QR déconnecté : ${s['lastError']}';
    }
    return null;
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
