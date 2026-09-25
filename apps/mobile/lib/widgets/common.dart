import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/api.dart';
import '../core/theme.dart';

class StatusBadge extends StatelessWidget {
  const StatusBadge(this.label, {super.key, this.tone = Tone.inactive, this.icon, this.dense = false});
  final String label;
  final Tone tone;
  final IconData? icon;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final c = toneColor(tone);
    return Container(
      padding: EdgeInsets.symmetric(horizontal: dense ? 8 : 10, vertical: dense ? 2 : 4),
      decoration: BoxDecoration(color: c.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(20)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[Icon(icon, size: dense ? 12 : 14, color: c), const SizedBox(width: 4)] else ...[
          Container(width: 7, height: 7, decoration: BoxDecoration(color: c, shape: BoxShape.circle)),
          const SizedBox(width: 6),
        ],
        Flexible(
          child: Text(label,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: c, fontWeight: FontWeight.w600, fontSize: dense ? 11 : 12.5)),
        ),
      ]),
    );
  }
}

Tone toneForRecipient(String? s) => switch (s) {
      'COMPLETED' => Tone.ok,
      'FAILED' => Tone.error,
      'TEMPLATE_REQUIRED' || 'NEEDS_REVIEW' => Tone.warning,
      'IN_PROGRESS' || 'PENDING' => Tone.info,
      _ => Tone.inactive,
    };

Tone toneForMessage(String? s) => switch (s) {
      'READ' || 'DELIVERED' || 'SENT' || 'ACCEPTED' => Tone.ok,
      'FAILED' => Tone.error,
      'UNCERTAIN' => Tone.warning,
      'SUBMITTING' || 'QUEUED' || 'PENDING' => Tone.info,
      _ => Tone.inactive,
    };

Tone toneForRun(String? s) => switch (s) {
      'RUNNING' => Tone.ok,
      'PAUSED' => Tone.warning,
      'COMPLETED' => Tone.info,
      _ => Tone.inactive,
    };

class SectionCard extends StatelessWidget {
  const SectionCard({super.key, this.title, this.icon, this.trailing, required this.child, this.subtitle, this.padding});
  final String? title;
  final String? subtitle;
  final IconData? icon;
  final Widget? trailing;
  final Widget child;
  final EdgeInsets? padding;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: padding ?? const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (title != null) ...[
            Row(children: [
              if (icon != null) ...[
                Container(
                  padding: const EdgeInsets.all(7),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.primary.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(icon, size: 18, color: theme.colorScheme.primary),
                ),
                const SizedBox(width: 10),
              ],
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title!, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                  if (subtitle != null)
                    Text(subtitle!, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
                ]),
              ),
              ?trailing,
            ]),
            const SizedBox(height: 14),
          ],
          child,
        ]),
      ),
    );
  }
}

class InfoRow extends StatelessWidget {
  const InfoRow(this.label, this.value, {super.key, this.copyable = false, this.valueWidget});
  final String label;
  final String? value;
  final bool copyable;
  final Widget? valueWidget;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(
          width: 130,
          child: Text(label, style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
        ),
        Expanded(
          child: valueWidget ??
              SelectableText(value == null || value!.isEmpty ? '—' : value!,
                  style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
        ),
        if (copyable && value != null && value!.isNotEmpty)
          IconButton(
            visualDensity: VisualDensity.compact,
            tooltip: 'Copier',
            icon: const Icon(Icons.copy, size: 18),
            onPressed: () => copyText(context, value!),
          ),
      ]),
    );
  }
}

Future<void> copyText(BuildContext context, String text, {String message = 'Copié'}) async {
  await Clipboard.setData(ClipboardData(text: text));
  if (context.mounted) showSnack(context, message);
}

void showSnack(BuildContext context, String message, {bool error = false}) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(
      content: Text(message),
      backgroundColor: error ? StatusColors.error : null,
      behavior: SnackBarBehavior.floating,
    ));
}

/// Affiche une erreur API complète (message + détails) dans une boîte de dialogue.
Future<void> showError(BuildContext context, Object e, {String title = 'Erreur'}) async {
  final msg = e is ApiException ? e.message : '$e';
  final lines = e is ApiException ? e.detailLines : const <String>[];
  if (!context.mounted) return;
  await showDialog<void>(
    context: context,
    builder: (ctx) => AlertDialog(
      icon: const Icon(Icons.error_outline, color: StatusColors.error),
      title: Text(title),
      content: SingleChildScrollView(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text(msg),
          if (lines.isNotEmpty) ...[
            const SizedBox(height: 10),
            ...lines.map((l) => Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Text('• '),
                    Expanded(child: Text(l)),
                  ]),
                )),
          ],
        ]),
      ),
      actions: [
        TextButton(onPressed: () => copyText(ctx, [msg, ...lines].join('\n'), message: 'Erreur copiée'), child: const Text('Copier')),
        FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK')),
      ],
    ),
  );
}

/// Exécute une action réseau avec gestion d'erreur uniforme.
Future<T?> runAction<T>(BuildContext context, Future<T> Function() fn, {String? success}) async {
  try {
    final r = await fn();
    if (success != null && context.mounted) showSnack(context, success);
    return r;
  } catch (e) {
    if (context.mounted) await showError(context, e);
    return null;
  }
}

Future<bool> confirm(BuildContext context,
    {required String title, required String message, String ok = 'Confirmer', bool danger = false}) async {
  final r = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Annuler')),
        FilledButton(
          style: danger ? FilledButton.styleFrom(backgroundColor: StatusColors.error) : null,
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(ok),
        ),
      ],
    ),
  );
  return r ?? false;
}

Future<String?> promptText(BuildContext context,
    {required String title, String? label, String? hint, String initial = '', TextInputType? keyboard}) async {
  final ctrl = TextEditingController(text: initial);
  final r = await showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: TextField(
        controller: ctrl,
        autofocus: true,
        keyboardType: keyboard,
        decoration: InputDecoration(labelText: label, hintText: hint),
        onSubmitted: (v) => Navigator.pop(ctx, v),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Annuler')),
        FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text), child: const Text('Valider')),
      ],
    ),
  );
  return r?.trim();
}

/// Charge une donnée et affiche chargement / erreur (avec « Réessayer ») / contenu.
class AsyncView<T> extends StatefulWidget {
  const AsyncView({super.key, required this.load, required this.builder, this.refreshKey});
  final Future<T> Function() load;
  final Widget Function(BuildContext context, T data, Future<void> Function() reload) builder;
  final Object? refreshKey;

  @override
  State<AsyncView<T>> createState() => _AsyncViewState<T>();
}

class _AsyncViewState<T> extends State<AsyncView<T>> {
  T? _data;
  Object? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  @override
  void didUpdateWidget(covariant AsyncView<T> old) {
    super.didUpdateWidget(old);
    if (old.refreshKey != widget.refreshKey) _reload();
  }

  Future<void> _reload() async {
    setState(() => _loading = _data == null);
    try {
      final d = await widget.load();
      if (!mounted) return;
      setState(() {
        _data = d;
        _error = null;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()));
    if (_error != null && _data == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.cloud_off, size: 42, color: StatusColors.error),
            const SizedBox(height: 12),
            Text('$_error', textAlign: TextAlign.center),
            const SizedBox(height: 12),
            FilledButton.icon(onPressed: _reload, icon: const Icon(Icons.refresh), label: const Text('Réessayer')),
          ]),
        ),
      );
    }
    return widget.builder(context, _data as T, _reload);
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.message, this.action});
  final IconData icon;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(children: [
        Icon(icon, size: 40, color: StatusColors.inactive),
        const SizedBox(height: 8),
        Text(message, textAlign: TextAlign.center, style: const TextStyle(color: StatusColors.inactive)),
        if (action != null) ...[const SizedBox(height: 12), action!],
      ]),
    );
  }
}

/// Page à contenu centré et largeur maximale (confortable sur téléphone comme sur le web).
class PageBody extends StatelessWidget {
  const PageBody({super.key, required this.children, this.onRefresh, this.maxWidth = 980});
  final List<Widget> children;
  final Future<void> Function()? onRefresh;
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    final list = ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      children: [
        Center(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: maxWidth),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [for (final c in children) Padding(padding: const EdgeInsets.only(bottom: 14), child: c)],
            ),
          ),
        ),
      ],
    );
    return onRefresh == null ? list : RefreshIndicator(onRefresh: onRefresh!, child: list);
  }
}

/// Bouton qui se désactive pendant l'action (protection contre le double clic).
class BusyButton extends StatefulWidget {
  const BusyButton({super.key, required this.label, required this.onPressed, this.icon, this.outlined = false, this.color});
  final String label;
  final IconData? icon;
  final Future<void> Function()? onPressed;
  final bool outlined;
  final Color? color;

  @override
  State<BusyButton> createState() => _BusyButtonState();
}

class _BusyButtonState extends State<BusyButton> {
  bool _busy = false;

  Future<void> _run() async {
    if (_busy || widget.onPressed == null) return;
    setState(() => _busy = true);
    try {
      await widget.onPressed!();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final icon = _busy
        ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
        : (widget.icon != null ? Icon(widget.icon, size: 18) : null);
    final onPressed = _busy || widget.onPressed == null ? null : _run;
    final style = widget.color == null
        ? null
        : (widget.outlined
            ? OutlinedButton.styleFrom(foregroundColor: widget.color)
            : FilledButton.styleFrom(backgroundColor: widget.color));
    if (widget.outlined) {
      return icon == null
          ? OutlinedButton(style: style, onPressed: onPressed, child: Text(widget.label))
          : OutlinedButton.icon(style: style, onPressed: onPressed, icon: icon, label: Text(widget.label));
    }
    return icon == null
        ? FilledButton(style: style, onPressed: onPressed, child: Text(widget.label))
        : FilledButton.icon(style: style, onPressed: onPressed, icon: icon, label: Text(widget.label));
  }
}

class StatTile extends StatelessWidget {
  const StatTile({super.key, required this.label, required this.value, this.tone = Tone.info, this.icon});
  final String label;
  final String value;
  final Tone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final c = toneColor(tone);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: c.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(12)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          if (icon != null) ...[Icon(icon, size: 14, color: c), const SizedBox(width: 4)],
          Flexible(child: Text(label, overflow: TextOverflow.ellipsis, style: TextStyle(color: c, fontSize: 12, fontWeight: FontWeight.w600))),
        ]),
        const SizedBox(height: 4),
        Text(value, style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
      ]),
    );
  }
}

/// Grille responsive : 1 colonne sur téléphone étroit, 2 ou 3 au-delà.
class ResponsiveGrid extends StatelessWidget {
  const ResponsiveGrid({super.key, required this.children, this.minItemWidth = 280, this.spacing = 14});
  final List<Widget> children;
  final double minItemWidth;
  final double spacing;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      final cols = (c.maxWidth / minItemWidth).floor().clamp(1, 4);
      final w = (c.maxWidth - spacing * (cols - 1)) / cols;
      return Wrap(
        spacing: spacing,
        runSpacing: spacing,
        children: [for (final ch in children) SizedBox(width: w, child: ch)],
      );
    });
  }
}
