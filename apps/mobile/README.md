# Application mobile / web (Flutter)

Interface de l’application : aucune automatisation ne tourne sur le téléphone, tout est exécuté par le backend.

```bash
flutter pub get
flutter run --dart-define=BACKEND_URL=http://10.0.2.2:3000          # émulateur Android
flutter build apk --release --dart-define=BACKEND_URL=https://xxx.up.railway.app
flutter build web --release --no-web-resources-cdn --dart-define=BACKEND_URL=https://xxx.up.railway.app
flutter analyze && flutter test
```

Structure : `lib/core` (API, configuration, état), `lib/widgets` (composants, minuteur, médias, import),
`lib/screens` (Accueil, Connexion WhatsApp, Automation 1, Automation 2, Contacts, Médias, Historique, Logs, Réglages).

Voir le README principal pour l’installation de l’APK et le changement d’URL du backend.
