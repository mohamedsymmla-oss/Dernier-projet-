import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api.dart';
import '../core/app_state.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../widgets/common.dart';

class ConnectionScreen extends StatefulWidget {
  const ConnectionScreen({super.key});

  @override
  State<ConnectionScreen> createState() => _ConnectionScreenState();
}

class _ConnectionScreenState extends State<ConnectionScreen> {
  int _refresh = 0;
  Map<String, dynamic>? _lastTest;

  void _reload() {
    setState(() => _refresh++);
    context.read<AppState>().refreshConnection();
  }

  Future<Map<String, dynamic>> _load() async {
    final conns = (await api.get('/connections') as List).cast<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
    final providers = (await api.get('/providers') as List).cast<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
    return {'connections': conns, 'providers': providers};
  }

  @override
  Widget build(BuildContext context) {
    return AsyncView<Map<String, dynamic>>(
      refreshKey: _refresh,
      load: _load,
      builder: (context, data, reload) {
        final conns = data['connections'] as List<Map<String, dynamic>>;
        final providers = data['providers'] as List<Map<String, dynamic>>;
        final active = conns.where((c) => c['isActive'] == true).firstOrNull ?? conns.where((c) => c['status'] != 'DISCONNECTED').firstOrNull;
        final others = conns.where((c) => c != active).toList();
        return PageBody(onRefresh: reload, children: [
          if (active == null)
            SectionCard(
              title: 'Aucune connexion',
              icon: Icons.link_off,
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                const Text('Connectez votre WhatsApp Business via un fournisseur. La clé API reste sur le serveur, chiffrée.'),
                const SizedBox(height: 12),
                BusyButton(label: 'Connecter', icon: Icons.add_link, onPressed: () => _connectDialog(providers)),
              ]),
            )
          else
            _activeCard(active, providers),
          if (_lastTest != null) _testCard(_lastTest!),
          _capabilitiesCard(providers),
          if (others.isNotEmpty)
            SectionCard(
              title: 'Autres connexions',
              icon: Icons.history,
              subtitle: "Conservées pour l'historique",
              child: Column(children: [
                for (final c in others)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text('${c['label']} — ${c['phoneNumber'] ?? 'sans numéro'}'),
                    subtitle: Text('${c['providerName']} • ${c['mode']} • créée le ${fmtDate(c['createdAt'])}'),
                    trailing: Wrap(spacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
                      _statusBadge(c['status'] as String),
                      if (c['status'] == 'CONNECTED')
                        TextButton(
                          onPressed: () => runAction(context, () => api.post('/connections/${c['id']}/activate'), success: 'Connexion activée')
                              .then((_) => _reload()),
                          child: const Text('Activer'),
                        ),
                    ]),
                  ),
              ]),
            ),
          if (active != null)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(onPressed: () => _connectDialog(providers), icon: const Icon(Icons.add), label: const Text('Ajouter une autre connexion')),
            ),
        ]);
      },
    );
  }

  Widget _statusBadge(String s) => switch (s) {
        'CONNECTED' => const StatusBadge('Connecté', tone: Tone.ok),
        'DISCONNECTED' => const StatusBadge('Déconnecté', tone: Tone.inactive),
        'ERROR' => const StatusBadge('Erreur', tone: Tone.error),
        _ => const StatusBadge('Non vérifié', tone: Tone.warning),
      };

  Widget _activeCard(Map<String, dynamic> c, List<Map<String, dynamic>> providers) {
    final id = c['id'] as String;
    return SectionCard(
      title: 'Connexion WhatsApp',
      icon: Icons.chat,
      trailing: _statusBadge(c['status'] as String),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        InfoRow('Fournisseur', '${c['providerName']}'),
        InfoRow('Mode', null, valueWidget: Align(
          alignment: Alignment.centerLeft,
          child: StatusBadge(c['mode'] == 'TEST' ? 'TEST' : 'PRODUCTION', tone: c['mode'] == 'TEST' ? Tone.warning : Tone.ok, dense: true),
        )),
        InfoRow('État', c['statusDetail'] as String?),
        InfoRow('Numéro WhatsApp', c['phoneNumber'] as String?, copyable: true),
        InfoRow('Projet', c['projectName'] as String?),
        InfoRow('WABA', c['wabaId'] as String?, copyable: true),
        InfoRow('Phone Number ID', c['phoneNumberId'] as String?, copyable: true),
        InfoRow('Statut du numéro', c['numberStatus'] as String?),
        InfoRow('Clé API', c['apiKeyHint'] as String?),
        InfoRow('Secret webhook', c['hasWebhookSecret'] == true ? c['webhookSecretHint'] as String? : 'Non configuré (signatures non vérifiées)'),
        InfoRow('Webhook', c['webhookUrl'] as String? ?? 'PUBLIC_BACKEND_URL non défini sur le serveur', copyable: c['webhookUrl'] != null),
        InfoRow('Dernier webhook', fmtAgo(c['lastWebhookAt'])),
        InfoRow('Dernier test', fmtDateTime(c['lastTestAt'])),
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          if (c['status'] == 'DISCONNECTED')
            BusyButton(label: 'Connecter', icon: Icons.link, onPressed: () => _editDialog(c, reconnect: true))
          else ...[
            BusyButton(label: 'Tester la connexion', icon: Icons.fact_check_outlined, onPressed: () => _test(id)),
            BusyButton(label: 'Modifier', icon: Icons.edit_outlined, outlined: true, onPressed: () => _editDialog(c)),
            BusyButton(
              label: 'Copier le webhook',
              icon: Icons.copy,
              outlined: true,
              onPressed: c['webhookUrl'] == null ? null : () => copyText(context, c['webhookUrl'] as String, message: 'URL du webhook copiée'),
            ),
            BusyButton(label: 'Synchroniser', icon: Icons.sync, outlined: true, onPressed: () => _syncNumbers(id)),
            BusyButton(label: 'Événements manqués', icon: Icons.manage_search, outlined: true, onPressed: () => _syncEvents(id)),
            BusyButton(
              label: 'Déconnecter',
              icon: Icons.link_off,
              outlined: true,
              color: StatusColors.error,
              onPressed: () async {
                if (await confirm(context,
                    title: 'Déconnecter ?',
                    message: 'La clé API sera effacée du serveur. Les campagnes en cours seront mises en pause. '
                        'Tout l’historique (contacts, envois, réponses) est conservé.',
                    ok: 'Déconnecter',
                    danger: true)) {
                  if (!mounted) return;
                  await runAction(context, () => api.post('/connections/$id/disconnect'), success: 'Déconnecté');
                  _reload();
                }
              },
            ),
          ],
        ]),
      ]),
    );
  }

  Future<void> _test(String id) async {
    final sendTest = await showDialog<bool>(
      context: context,
      builder: (ctx) {
        var v = false;
        return StatefulBuilder(
          builder: (ctx, set) => AlertDialog(
            title: const Text('Tester la connexion'),
            content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Vérifications réelles : API, projet, WABA, numéro, webhook.'),
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                value: v,
                onChanged: (x) => set(() => v = x ?? false),
                title: const Text('Envoyer aussi un message de test à mon numéro de test'),
              ),
            ]),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Annuler')),
              FilledButton(onPressed: () => Navigator.pop(ctx, v), child: const Text('Lancer le test')),
            ],
          ),
        );
      },
    );
    if (sendTest == null || !mounted) return;
    final r = await runAction(context, () => api.post('/connections/$id/test', {'sendTestMessage': sendTest}));
    if (r != null) {
      setState(() => _lastTest = Map<String, dynamic>.from(r as Map));
      _reload();
    }
  }

  Widget _testCard(Map<String, dynamic> t) {
    IconData icon(String s) => switch (s) {
          'ok' => Icons.check_circle,
          'warning' => Icons.warning_amber,
          'error' => Icons.cancel,
          'unavailable' => Icons.help_outline,
          _ => Icons.remove_circle_outline,
        };
    Tone tone(String s) => switch (s) { 'ok' => Tone.ok, 'warning' => Tone.warning, 'error' => Tone.error, _ => Tone.inactive };
    return SectionCard(
      title: 'Résultat du test',
      subtitle: fmtDateTime(t['testedAt']),
      icon: Icons.fact_check,
      trailing: StatusBadge(t['connected'] == true ? 'Connecté' : 'Problème détecté', tone: t['connected'] == true ? Tone.ok : Tone.error),
      child: Column(children: [
        for (final c in (t['checks'] as List).cast<Map>())
          ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: Icon(icon(c['status'] as String), color: toneColor(tone(c['status'] as String))),
            title: Text('${c['label']}', style: const TextStyle(fontWeight: FontWeight.w600)),
            subtitle: Text('${c['detail']}'),
          ),
      ]),
    );
  }

  Widget _capabilitiesCard(List<Map<String, dynamic>> providers) {
    const labels = {
      'sendText': 'Texte',
      'sendAudio': 'Audio standard',
      'sendVoiceNote': 'Message vocal (PTT)',
      'sendImage': 'Images',
      'sendTemplate': 'Modèles WhatsApp',
      'webhookSignature': 'Signature webhook',
      'fetchLogs': 'Synchronisation des logs',
      'webhookConfigCheck': 'Vérification config webhook',
      'partnerOnboarding': 'Partner API / Embedded Onboarding',
      'sandbox': 'Mode test / sandbox',
    };
    return SectionCard(
      title: 'Capacités réelles des fournisseurs',
      icon: Icons.verified_outlined,
      subtitle: 'Seuls les fournisseurs réellement développés sont listés',
      child: Column(children: [
        for (final p in providers)
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: Text('${p['name']}', style: const TextStyle(fontWeight: FontWeight.w700)),
            children: [
              for (final e in labels.entries)
                if ((p['capabilities'] as Map)[e.key] is Map)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text(e.value),
                    subtitle: Text('${((p['capabilities'] as Map)[e.key] as Map)['note']}'),
                    trailing: _capBadge('${((p['capabilities'] as Map)[e.key] as Map)['status']}'),
                  ),
            ],
          ),
      ]),
    );
  }

  Widget _capBadge(String s) => switch (s) {
        'SUPPORTED' => const StatusBadge('Disponible', tone: Tone.ok, dense: true),
        'UNVERIFIED' => const StatusBadge('À vérifier', tone: Tone.warning, dense: true),
        _ => const StatusBadge('Non disponible', tone: Tone.inactive, dense: true),
      };

  Future<void> _connectDialog(List<Map<String, dynamic>> providers) async {
    final label = TextEditingController(text: 'SendZen');
    final key = TextEditingController();
    final secret = TextEditingController();
    final baseUrl = TextEditingController();
    var provider = providers.firstOrNull?['id'] as String? ?? 'sendzen';
    var mode = 'PRODUCTION';
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) => AlertDialog(
          title: const Text('Connecter WhatsApp'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              DropdownButtonFormField<String>(
                initialValue: provider,
                decoration: const InputDecoration(labelText: 'Fournisseur'),
                items: [for (final p in providers) DropdownMenuItem(value: p['id'] as String, child: Text('${p['name']}'))],
                onChanged: (v) => set(() => provider = v ?? provider),
              ),
              const SizedBox(height: 10),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'PRODUCTION', label: Text('Production'), icon: Icon(Icons.verified)),
                  ButtonSegment(value: 'TEST', label: Text('Test'), icon: Icon(Icons.science)),
                ],
                selected: {mode},
                onSelectionChanged: (s) => set(() => mode = s.first),
              ),
              const SizedBox(height: 10),
              TextField(controller: label, decoration: const InputDecoration(labelText: 'Nom de la connexion')),
              const SizedBox(height: 10),
              TextField(controller: key, obscureText: true, decoration: const InputDecoration(labelText: 'Clé API', helperText: 'Envoyée au serveur, stockée chiffrée, jamais dans l’application')),
              const SizedBox(height: 10),
              TextField(controller: secret, obscureText: true, decoration: const InputDecoration(labelText: 'Secret webhook (recommandé)', helperText: 'Pour vérifier la signature X-Hub-Signature-256')),
              if (mode == 'TEST') ...[
                const SizedBox(height: 10),
                TextField(controller: baseUrl, decoration: const InputDecoration(labelText: 'URL API sandbox (optionnel)')),
              ],
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Annuler')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Vérifier et connecter')),
          ],
        ),
      ),
    );
    if (ok != true || !mounted) return;
    final r = await runAction(
      context,
      () => api.post('/connections', {
        'provider': provider,
        'label': label.text.trim().isEmpty ? 'SendZen' : label.text.trim(),
        'mode': mode,
        'apiKey': key.text.trim(),
        if (secret.text.trim().isNotEmpty) 'webhookSecret': secret.text.trim(),
        if (baseUrl.text.trim().isNotEmpty) 'apiBaseUrl': baseUrl.text.trim(),
      }),
    );
    if (r == null || !mounted) return;
    final conn = (r as Map)['connection'] as Map;
    final numbers = (r['numbers'] as List).cast<Map>();
    if (conn['phoneNumber'] == null && numbers.isNotEmpty) {
      await _pickNumber(conn['id'] as String, numbers);
    } else if (numbers.isEmpty) {
      await showError(context, ApiException('Clé valide, mais aucun numéro WhatsApp trouvé dans ce compte SendZen.'));
    }
    _reload();
  }

  Future<void> _pickNumber(String id, List<Map> numbers) async {
    final chosen = await showDialog<String>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('Choisir le numéro WhatsApp'),
        children: [
          for (final n in numbers)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(ctx, n['phoneNumberId'] as String),
              child: ListTile(
                title: Text('${n['phoneNumber']}'),
                subtitle: Text('${n['projectName']} • WABA ${n['wabaId']} • ${n['status']}'),
              ),
            ),
        ],
      ),
    );
    if (chosen == null || !mounted) return;
    await runAction(context, () => api.post('/connections/$id/select-number', {'phoneNumberId': chosen}), success: 'Numéro sélectionné');
  }

  Future<void> _syncNumbers(String id) async {
    final nums = await runAction(context, () => api.get('/connections/$id/numbers'));
    if (nums == null || !mounted) return;
    await _pickNumber(id, (nums as List).cast<Map>());
    _reload();
  }

  Future<void> _syncEvents(String id) async {
    final r = await runAction(context, () => api.post('/connections/$id/sync', {'sinceHours': 72}));
    if (r == null || !mounted) return;
    final m = r as Map;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Synchronisation des événements'),
        content: Text([
          'Webhooks stockés retraités : ${m['reprocessed']}',
          if (m['logsAvailable'] == true) ...[
            'Pages de logs parcourues : ${m['pages']}',
            'Événements récupérés : ${m['fetched']}',
            'Nouveaux : ${m['newEvents']}',
            'Déjà connus (ignorés) : ${m['duplicates']}',
          ] else
            '${m['detail']}',
        ].join('\n')),
        actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
      ),
    );
  }

  Future<void> _editDialog(Map<String, dynamic> c, {bool reconnect = false}) async {
    final label = TextEditingController(text: c['label'] as String?);
    final key = TextEditingController();
    final secret = TextEditingController();
    var clearSecret = false;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) => AlertDialog(
          title: Text(reconnect ? 'Reconnecter' : 'Modifier la connexion'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              TextField(controller: label, decoration: const InputDecoration(labelText: 'Nom')),
              const SizedBox(height: 10),
              TextField(
                controller: key,
                obscureText: true,
                decoration: InputDecoration(labelText: reconnect ? 'Clé API' : 'Nouvelle clé API (laisser vide pour conserver)', helperText: 'Actuelle : ${c['apiKeyHint'] ?? '—'}'),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: secret,
                obscureText: true,
                decoration: InputDecoration(labelText: 'Nouveau secret webhook', helperText: 'Actuel : ${c['webhookSecretHint'] ?? 'aucun'}'),
              ),
              if (c['hasWebhookSecret'] == true)
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  value: clearSecret,
                  onChanged: (v) => set(() => clearSecret = v ?? false),
                  title: const Text('Supprimer le secret webhook'),
                ),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Annuler')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Enregistrer')),
          ],
        ),
      ),
    );
    if (ok != true || !mounted) return;
    await runAction(
      context,
      () => api.patch('/connections/${c['id']}', {
        'label': label.text.trim(),
        if (key.text.trim().isNotEmpty) 'apiKey': key.text.trim(),
        if (secret.text.trim().isNotEmpty) 'webhookSecret': secret.text.trim() else if (clearSecret) 'webhookSecret': null,
      }),
      success: 'Connexion mise à jour',
    );
    if (reconnect && mounted && key.text.trim().isNotEmpty) await _syncNumbers(c['id'] as String);
    _reload();
  }
}
