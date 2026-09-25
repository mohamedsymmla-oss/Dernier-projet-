import 'package:flutter/material.dart';

/// Couleurs d'état : vert = OK, orange = attention, rouge = erreur, gris = inactif.
class StatusColors {
  static const ok = Color(0xFF1E9E5A);
  static const warning = Color(0xFFE08A00);
  static const error = Color(0xFFD64545);
  static const inactive = Color(0xFF8A94A6);
  static const info = Color(0xFF2F6FDE);
}

enum Tone { ok, warning, error, inactive, info }

Color toneColor(Tone t) => switch (t) {
      Tone.ok => StatusColors.ok,
      Tone.warning => StatusColors.warning,
      Tone.error => StatusColors.error,
      Tone.inactive => StatusColors.inactive,
      Tone.info => StatusColors.info,
    };

ThemeData buildTheme(Brightness b) {
  final scheme = ColorScheme.fromSeed(seedColor: const Color(0xFF0F7B6C), brightness: b);
  final dark = b == Brightness.dark;
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: dark ? const Color(0xFF101416) : const Color(0xFFF3F6F7),
    cardTheme: CardThemeData(
      elevation: 0,
      color: dark ? const Color(0xFF1A2023) : Colors.white,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: dark ? const Color(0xFF2A3236) : const Color(0xFFE3E8EA)),
      ),
      margin: EdgeInsets.zero,
    ),
    appBarTheme: AppBarTheme(
      centerTitle: false,
      backgroundColor: dark ? const Color(0xFF101416) : const Color(0xFFF3F6F7),
      surfaceTintColor: Colors.transparent,
      titleTextStyle: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: scheme.onSurface),
    ),
    inputDecorationTheme: InputDecorationTheme(
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
      filled: true,
      fillColor: dark ? const Color(0xFF151A1C) : const Color(0xFFF8FAFA),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(0, 46),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size(0, 46),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
    chipTheme: ChipThemeData(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20))),
  );
}
