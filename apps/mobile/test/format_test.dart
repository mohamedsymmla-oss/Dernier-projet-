import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:wa_automation/core/api.dart';
import 'package:wa_automation/core/format.dart';

void main() {
  setUpAll(() => initializeDateFormatting('fr_FR'));

  test('tailles et durées lisibles', () {
    expect(fmtBytes(500), '500 o');
    expect(fmtBytes(2048), '2 Ko');
    expect(fmtDurationMs(90000), '1:30');
    expect(fmtDurationMs(null), '—');
  });

  test("les statuts distinguent acceptation API, envoi, livraison et lecture", () {
    expect(messageStatusLabels['ACCEPTED'], "Accepté par l'API");
    expect(messageStatusLabels['SENT'], 'Envoyé');
    expect(messageStatusLabels['DELIVERED'], 'Livré');
    expect(messageStatusLabels['READ'], 'Lu');
  });

  test('les erreurs serveur détaillées sont lisibles', () {
    final e = ApiException('Média refusé', details: [
      {'label': 'Taille', 'detail': '20 Mo (max 16 Mo)'},
      {'field': 'audio', 'message': 'Audio non configuré'},
    ]);
    expect(e.detailLines, ['Taille : 20 Mo (max 16 Mo)', 'audio : Audio non configuré']);
  });
}
