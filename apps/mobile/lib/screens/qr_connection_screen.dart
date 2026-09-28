import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../core/api.dart';
import '../core/app_state.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../widgets/common.dart';

/// Connexion WhatsApp par QR code (appareil lié). Totalement séparée de la connexion fournisseur.
class QrConnectionScreen extends StatefulWidget {
  const QrConnectionScreen({super.key});

  @override
  State<QrConnectionScreen> createState() => _QrConnectionScreenState();
}

class _QrConnectionScreenState extends State<QrConnectionScreen> {
  Map<String, dynamic>? _s;
  Object? _error;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _load();
    // Le QR change toutes les ~20 s : on rafraîchit toutes les 2 s tant que l'écran est ouvert.
    _poll = Timer.periodic(const Duration(seconds: 2), (_) => _load());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = Map<String, dynamic>.from(await api.get('/qr/session') as Map);
      if (!mounted) return;
      final wasConnected = _s?['status'] == 'CONNECTED';
      setState(() {
        _s = r;
        _error = null;
      });
      if (!wasConnected && r['status'] == 'CONNECTED') {
        showSnack(context, 'WhatsApp QR connecté : ${r['phoneNumber'] ?? ''}');
        context.read<AppState>().refreshQr();
      }
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _s;
    if (s == null) {
      return _error != null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text('$_error')))
          : const Center(child: CircularProgressIndicator());
    }
    final status = s['status'] as String;
    final safety = Map<String, dynamic>.from(s['safety'] as Map);
    return PageBody(onRefresh: _load, children: [
      if (safety['emergencyStopped'] == true) _EmergencyCard(reason: safety['emergencyReason'] as String?, at: safety['emergencyAt'], onReset: _load),
      _statusCard(s, status),
      if (status == 'WAITING_SCAN' && s['qr'] != null) _qrCard(s['qr'] as String),
      if (s['sameNumberAsProvider'] == true)
        const SectionCard(
          title: 'Même numéro que le fournisseur',
          icon: Icons.warning_amber,
          child: Text(
            'Ce numéro est aussi connecté chez le fournisseur (API). Les deux parties restent séparées, mais évitez de '
            'lancer une campagne sur les mêmes contacts des deux côtés.',
          ),
        ),
      _SafetyCard(safety: safety, onSaved: _load),
      _riskCard(),
      _eventsCard((s['events'] as List).cast<Map>()),
    ]);
  }

  Widget _statusCard(Map<String, dynamic> s, String status) {
    final (label, tone) = switch (status) {
      'CONNECTED' => ('Connecté', Tone.ok),
      'WAITING_SCAN' => ('En attente de scan', Tone.warning),
      'CONNECTING' => ('Connexion en cours…', Tone.info),
      'LOGGED_OUT' => ('Déconnecté (session supprimée)', Tone.inactive),
      _ => ('Déconnecté', Tone.error),
    };
    return SectionCard(
      title: 'CONNEXION WHATSAPP PAR QR CODE',
      icon: Icons.qr_code_2,
      subtitle: 'Appareil lié, comme WhatsApp Web — indépendant du fournisseur',
      trailing: StatusBadge(label, tone: tone),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        InfoRow('Numéro', s['phoneNumber'] as String?),
        InfoRow('Nom WhatsApp', s['pushName'] as String?),
        InfoRow('Lié depuis', fmtDateTime(s['pairedAt'])),
        if (status == 'CONNECTED') InfoRow('Connecté depuis', fmtDateTime(s['connectedAt'])),
        if (s['lastError'] != null && status != 'CONNECTED') InfoRow('Dernier message', s['lastError'] as String?),
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          if (status != 'CONNECTED' && status != 'WAITING_SCAN' && status != 'CONNECTING')
            BusyButton(
              label: 'Connecter (afficher le QR)',
              icon: Icons.qr_code_scanner,
              onPressed: () async {
                await runAction(context, () => api.post('/qr/session/start'));
                await _load();
              },
            ),
          if (status == 'CONNECTED' || status == 'WAITING_SCAN' || status == 'CONNECTING')
            BusyButton(
              label: 'Déconnecter et supprimer la session',
              icon: Icons.link_off,
              outlined: true,
              color: StatusColors.error,
              onPressed: () async {
                final ok = await confirm(context,
                    title: 'Déconnecter WhatsApp QR ?',
                    message: 'L’appareil sera délié de votre WhatsApp et la session supprimée du serveur. Les campagnes QR '
                        'seront mises en pause. L’historique est conservé. La partie fournisseur n’est pas concernée.',
                    ok: 'Déconnecter',
                    danger: true);
                if (!ok || !mounted) return;
                await runAction(context, () => api.post('/qr/session/logout'), success: 'Session QR supprimée');
                await _load();
                if (mounted) context.read<AppState>().refreshQr();
              },
            ),
        ]),
      ]),
    );
  }

  Widget _qrCard(String qr) {
    return SectionCard(
      title: 'Scannez ce QR code',
      icon: Icons.qr_code,
      subtitle: 'Il se renouvelle automatiquement toutes les ~20 secondes',
      child: Column(children: [
        Container(
          padding: const EdgeInsets.all(12),
          color: Colors.white,
          child: QrImageView(data: qr, size: 260, backgroundColor: Colors.white),
        ),
        const SizedBox(height: 12),
        const Text(
          'Sur votre téléphone : ouvrez WhatsApp Business, touchez le menu (les trois points) ou Réglages, '
          'puis « Appareils connectés » et « Connecter un appareil », et visez ce QR code. '
          'La connexion est détectée automatiquement.',
          textAlign: TextAlign.center,
        ),
      ]),
    );
  }

  Widget _riskCard() {
    return const SectionCard(
      title: 'À savoir',
      icon: Icons.info_outline,
      child: Text(
        'La connexion par QR utilise WhatsApp comme un appareil lié non officiel. WhatsApp peut restreindre un numéro '
        'qui envoie beaucoup de messages automatiques. Les garde-fous ci-dessus réduisent fortement ce risque mais ne '
        'peuvent pas le supprimer : commencez petit, envoyez surtout à des personnes qui vous connaissent.',
      ),
    );
  }

  Widget _eventsCard(List<Map> events) {
    const labels = {
      'start_requested': 'Connexion demandée',
      'qr_displayed': 'QR affiché',
      'connected': 'Connecté',
      'closed': 'Connexion fermée',
      'disconnected': 'Déconnecté',
      'logged_out': 'Session supprimée',
      'emergency_stop': 'Arrêt d’urgence',
      'emergency_reset': 'Arrêt d’urgence levé',
    };
    return SectionCard(
      title: 'Journal de connexion',
      icon: Icons.history,
      child: events.isEmpty
          ? const EmptyState(icon: Icons.history, message: 'Aucun événement')
          : Column(children: [
              for (final e in events)
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  title: Text(labels[e['type']] ?? '${e['type']}'),
                  subtitle: Text([
                    fmtDateTime(e['created_at']),
                    if ((e['detail'] as Map?)?['reason'] != null) '${(e['detail'] as Map)['reason']}',
                    if ((e['detail'] as Map?)?['code'] != null) 'code ${(e['detail'] as Map)['code']}',
                  ].join(' • ')),
                ),
            ]),
    );
  }
}

class _EmergencyCard extends StatelessWidget {
  const _EmergencyCard({required this.reason, required this.at, required this.onReset});
  final String? reason;
  final dynamic at;
  final Future<void> Function() onReset;

  @override
  Widget build(BuildContext context) {
    return Card(
      color: StatusColors.error.withValues(alpha: 0.1),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Row(children: [
            Icon(Icons.gpp_bad, color: StatusColors.error),
            SizedBox(width: 8),
            Expanded(child: Text('ARRÊT D’URGENCE — tous les envois QR sont suspendus', style: TextStyle(fontWeight: FontWeight.w800))),
          ]),
          const SizedBox(height: 8),
          Text('Raison : ${reason ?? 'signal de restriction'} (${fmtDateTime(at)})'),
          const SizedBox(height: 6),
          const Text('Conseil : attendez au moins 24 à 48 h, vérifiez votre téléphone, puis reprenez avec un plafond plus bas.'),
          const SizedBox(height: 10),
          Align(
            alignment: Alignment.centerLeft,
            child: BusyButton(
              label: 'Lever l’arrêt d’urgence',
              icon: Icons.lock_open,
              outlined: true,
              onPressed: () async {
                final ok = await confirm(context,
                    title: 'Lever l’arrêt d’urgence ?',
                    message: 'Les campagnes QR restent en pause : vous devrez les reprendre une par une.',
                    ok: 'Lever');
                if (!ok || !context.mounted) return;
                await runAction(context, () => api.post('/qr/emergency/reset'), success: 'Arrêt d’urgence levé');
                await onReset();
              },
            ),
          ),
        ]),
      ),
    );
  }
}

class _SafetyCard extends StatefulWidget {
  const _SafetyCard({required this.safety, required this.onSaved});
  final Map<String, dynamic> safety;
  final Future<void> Function() onSaved;

  @override
  State<_SafetyCard> createState() => _SafetyCardState();
}

class _SafetyCardState extends State<_SafetyCard> {
  Map<String, dynamic>? _settings;

  @override
  void initState() {
    super.initState();
    _loadSettings();
  }

  Future<void> _loadSettings() async {
    try {
      final r = Map<String, dynamic>.from(await api.get('/qr/settings') as Map);
      if (mounted) setState(() => _settings = r);
    } catch (_) {}
  }

  Future<void> _save(Map<String, dynamic> patch) async {
    final r = await runAction(context, () => api.put('/qr/settings', patch), success: 'Réglage enregistré');
    if (r != null && mounted) {
      setState(() => _settings = Map<String, dynamic>.from(r as Map));
      await widget.onSaved();
    }
  }

  @override
  Widget build(BuildContext context) {
    final st = _settings;
    final sf = widget.safety;
    final sent = sf['sentToday'] as int? ?? 0;
    final cap = sf['dailyCap'] as int? ?? 1;
    return SectionCard(
      title: 'PROTECTION DU NUMÉRO',
      icon: Icons.shield_outlined,
      subtitle: 'Appliquée par le serveur avant chaque contact',
      child: st == null
          ? const Center(child: CircularProgressIndicator())
          : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text('Messages envoyés aujourd’hui : $sent / $cap${sf['warmup'] == true ? ' (montée progressive : plafond réduit de moitié)' : ''}'),
              const SizedBox(height: 6),
              LinearProgressIndicator(value: (sent / cap).clamp(0, 1).toDouble(), minHeight: 8, borderRadius: BorderRadius.circular(6)),
              const SizedBox(height: 12),
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Plafond de messages par jour'),
                subtitle: Text('${st['dailyMessageCap']} messages (une séquence Automation 2 = 1 vocal + photos)'),
                trailing: TextButton(
                  child: const Text('Modifier'),
                  onPressed: () async {
                    final v = await promptText(context, title: 'Plafond par jour', initial: '${st['dailyMessageCap']}', keyboard: TextInputType.number);
                    final n = int.tryParse(v ?? '');
                    if (n != null) await _save({'dailyMessageCap': n});
                  },
                ),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: st['quietHoursEnabled'] == true,
                title: const Text('Heures calmes (aucun envoi)'),
                subtitle: Text('De ${st['quietStart']} à ${st['quietEnd']} — fuseau ${st['timezone']}'),
                onChanged: (v) => _save({'quietHoursEnabled': v}),
              ),
              Wrap(spacing: 8, children: [
                TextButton(
                  onPressed: () async {
                    final v = await promptText(context, title: 'Début des heures calmes (HH:MM)', initial: '${st['quietStart']}');
                    if (v != null && v.isNotEmpty) await _save({'quietStart': v});
                  },
                  child: const Text('Changer le début'),
                ),
                TextButton(
                  onPressed: () async {
                    final v = await promptText(context, title: 'Fin des heures calmes (HH:MM)', initial: '${st['quietEnd']}');
                    if (v != null && v.isNotEmpty) await _save({'quietEnd': v});
                  },
                  child: const Text('Changer la fin'),
                ),
                TextButton(
                  onPressed: () async {
                    final v = await promptText(context, title: 'Fuseau horaire', hint: 'Africa/Bamako, Africa/Dakar, Europe/Paris…', initial: '${st['timezone']}');
                    if (v != null && v.isNotEmpty) await _save({'timezone': v});
                  },
                  child: const Text('Fuseau horaire'),
                ),
              ]),
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Montée progressive'),
                subtitle: Text('Plafond divisé par 2 pendant les ${st['warmupDays']} premiers jours d’une nouvelle session'),
                trailing: TextButton(
                  child: const Text('Modifier'),
                  onPressed: () async {
                    final v = await promptText(context, title: 'Nombre de jours', initial: '${st['warmupDays']}', keyboard: TextInputType.number);
                    final n = int.tryParse(v ?? '');
                    if (n != null) await _save({'warmupDays': n});
                  },
                ),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: st['typingSimulation'] == true,
                title: const Text('« En train d’écrire / d’enregistrer » avant chaque message'),
                onChanged: (v) => _save({'typingSimulation': v}),
              ),
              const Text('Arrêt d’urgence automatique : au premier signal de restriction (refus, limite de débit), tous les envois QR s’arrêtent.',
                  style: TextStyle(fontSize: 12)),
            ]),
    );
  }
}
