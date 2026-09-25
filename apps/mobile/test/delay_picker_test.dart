import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wa_automation/core/format.dart';
import 'package:wa_automation/widgets/delay_picker.dart';

Widget _host(int value, ValueChanged<int> onChanged) => MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: DelayPicker(value: value, onChanged: onChanged))),
    );

void main() {
  test('format du délai MM:SS', () {
    expect(fmtDelay(1), '00:01');
    expect(fmtDelay(20), '00:20');
    expect(fmtDelay(70), '01:10');
    expect(fmtDelay(90), '01:30');
    expect(fmtDelay(120), '02:00');
  });

  testWidgets('affiche la valeur et les raccourcis de 1 s à 2 min', (tester) async {
    await tester.pumpWidget(_host(20, (_) {}));
    expect(find.text('00:20'), findsOneWidget);
    for (final label in ['1 s', '5 s', '10 s', '20 s', '30 s', '45 s', '1 min', '1 min 10', '1 min 30', '2 min']) {
      expect(find.widgetWithText(ChoiceChip, label), findsOneWidget, reason: label);
    }
  });

  testWidgets('un raccourci renvoie la valeur choisie (sans enregistrer lui-même)', (tester) async {
    int? got;
    await tester.pumpWidget(_host(20, (v) => got = v));
    await tester.tap(find.widgetWithText(ChoiceChip, '1 min 30'));
    expect(got, 90);
  });

  testWidgets('les roues ne permettent pas de dépasser 2 minutes', (tester) async {
    int value = 110;
    await tester.pumpWidget(StatefulBuilder(builder: (context, set) => _host(value, (v) => set(() => value = v))));
    // Roue des secondes : faire défiler vers le bas (augmenter)
    final wheels = find.byType(ListWheelScrollView);
    expect(wheels, findsNWidgets(2));
    await tester.drag(wheels.at(1), const Offset(0, -400));
    await tester.pumpAndSettle();
    expect(value, lessThanOrEqualTo(120));
    expect(value, greaterThanOrEqualTo(1));
  });

  testWidgets('les roues ne permettent pas 0 seconde', (tester) async {
    int value = 3;
    await tester.pumpWidget(StatefulBuilder(builder: (context, set) => _host(value, (v) => set(() => value = v))));
    await tester.drag(find.byType(ListWheelScrollView).at(1), const Offset(0, 400));
    await tester.pumpAndSettle();
    expect(value, greaterThanOrEqualTo(1));
  });
}
