import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../core/format.dart';

/// Sélecteur de délai façon montre : 1 seconde à 2 minutes.
/// Ne fait que choisir une valeur ; l'enregistrement en base est déclenché par le parent.
class DelayPicker extends StatefulWidget {
  const DelayPicker({super.key, required this.value, required this.onChanged, this.min = 1, this.max = 120});
  final int value;
  final ValueChanged<int> onChanged;
  final int min;
  final int max;

  static const presets = [1, 5, 10, 20, 30, 45, 60, 70, 90, 120];

  @override
  State<DelayPicker> createState() => _DelayPickerState();
}

class _DelayPickerState extends State<DelayPicker> {
  late FixedExtentScrollController _min;
  late FixedExtentScrollController _sec;
  bool _programmatic = false;

  @override
  void initState() {
    super.initState();
    _min = FixedExtentScrollController(initialItem: widget.value ~/ 60);
    _sec = FixedExtentScrollController(initialItem: widget.value % 60);
  }

  @override
  void didUpdateWidget(covariant DelayPicker old) {
    super.didUpdateWidget(old);
    if (old.value != widget.value) _syncWheels(widget.value);
  }

  void _syncWheels(int v) {
    _programmatic = true;
    if (_min.hasClients && _min.selectedItem != v ~/ 60) _min.jumpToItem(v ~/ 60);
    if (_sec.hasClients && _sec.selectedItem != v % 60) _sec.jumpToItem(v % 60);
    _programmatic = false;
  }

  void _fromWheels() {
    if (_programmatic) return;
    final m = _min.selectedItem;
    final s = _sec.selectedItem;
    var v = m * 60 + s;
    v = v.clamp(widget.min, widget.max);
    if (v != m * 60 + s) WidgetsBinding.instance.addPostFrameCallback((_) => _syncWheels(v));
    if (v != widget.value) widget.onChanged(v);
  }

  @override
  void dispose() {
    _min.dispose();
    _sec.dispose();
    super.dispose();
  }

  Widget _wheel(String label, FixedExtentScrollController c, int count) {
    final theme = Theme.of(context);
    return Column(children: [
      Text(label, style: theme.textTheme.labelMedium?.copyWith(letterSpacing: 1.2, color: theme.colorScheme.onSurfaceVariant)),
      const SizedBox(height: 6),
      Container(
        width: 78,
        height: 132,
        decoration: BoxDecoration(
          color: theme.colorScheme.primary.withValues(alpha: 0.06),
          borderRadius: BorderRadius.circular(14),
        ),
        child: ListWheelScrollView.useDelegate(
          controller: c,
          itemExtent: 40,
          diameterRatio: 1.3,
          physics: const FixedExtentScrollPhysics(),
          onSelectedItemChanged: (_) => _fromWheels(),
          childDelegate: ListWheelChildBuilderDelegate(
            childCount: count,
            builder: (_, i) => Center(
              child: Text(i.toString().padLeft(2, '0'),
                  style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w700, fontFeatures: [FontFeature.tabularFigures()])),
            ),
          ),
        ),
      ),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dial = SizedBox(
      width: 150,
      height: 150,
      child: CustomPaint(
        painter: _DialPainter(fraction: widget.value / widget.max, color: theme.colorScheme.primary, track: theme.colorScheme.outlineVariant),
        child: Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(fmtDelay(widget.value),
                style: theme.textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w800, fontFeatures: const [FontFeature.tabularFigures()])),
            Text('entre 2 contacts', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
          ]),
        ),
      ),
    );
    return Column(children: [
      Wrap(alignment: WrapAlignment.center, crossAxisAlignment: WrapCrossAlignment.center, spacing: 24, runSpacing: 16, children: [
        dial,
        Row(mainAxisSize: MainAxisSize.min, children: [
          _wheel('MINUTES', _min, 3),
          const Padding(padding: EdgeInsets.fromLTRB(8, 20, 8, 0), child: Text(':', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800))),
          _wheel('SECONDES', _sec, 60),
        ]),
      ]),
      const SizedBox(height: 14),
      Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.center, children: [
        for (final p in DelayPicker.presets)
          ChoiceChip(
            label: Text(p < 60 ? '$p s' : (p % 60 == 0 ? '${p ~/ 60} min' : '${p ~/ 60} min ${p % 60}')),
            selected: widget.value == p,
            onSelected: (_) => widget.onChanged(p),
          ),
      ]),
    ]);
  }
}

class _DialPainter extends CustomPainter {
  _DialPainter({required this.fraction, required this.color, required this.track});
  final double fraction;
  final Color color;
  final Color track;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final r = size.width / 2 - 8;
    final bg = Paint()
      ..color = track
      ..style = PaintingStyle.stroke
      ..strokeWidth = 8;
    canvas.drawCircle(center, r, bg);
    // Graduations toutes les 10 s
    final tick = Paint()
      ..color = track
      ..strokeWidth = 2;
    for (var i = 0; i < 12; i++) {
      final a = -math.pi / 2 + i * 2 * math.pi / 12;
      canvas.drawLine(center + Offset(math.cos(a), math.sin(a)) * (r - 14), center + Offset(math.cos(a), math.sin(a)) * (r - 8), tick);
    }
    final fg = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeWidth = 8;
    canvas.drawArc(Rect.fromCircle(center: center, radius: r), -math.pi / 2, 2 * math.pi * fraction.clamp(0.0, 1.0), false, fg);
  }

  @override
  bool shouldRepaint(covariant _DialPainter old) => old.fraction != fraction || old.color != color;
}
