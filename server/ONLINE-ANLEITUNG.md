# Pixelmonster online stellen (kostenlos, ca. 10 Minuten)

Der Online-Treffpunkt läuft kostenlos bei Cloudflare. Du brauchst nur einen Browser, keine Programmierkenntnisse und keine Kreditkarte. Das Ganze machst du nur einmal; deine Freunde müssen nichts einrichten.

## 1. Konto anlegen
Registriere dich kostenlos auf https://dash.cloudflare.com/sign-up und bestätige deine E-Mail-Adresse.

## 2. Datenbank anlegen
1. Links im Menü unter „Build“ auf **Storage & databases** klicken und dort **D1 SQL database** öffnen.
2. **Create** klicken, als Namen `pixelmonster` eingeben und bestätigen.

## 3. Worker (den Server) anlegen
1. Links im Menü unter „Build“ auf **Compute** klicken und dort **Workers & Pages** öffnen. Dann **Create** klicken.
2. **Start with Hello World** wählen, als Namen `pixelmonster` eingeben und **Deploy** klicken.
3. **Edit code** klicken, den gesamten Beispielcode löschen und stattdessen den kompletten Inhalt der Datei `worker.js` einfügen.
4. Oben rechts **Deploy** klicken.

## 4. Datenbank mit dem Worker verbinden
1. Unter **Compute → Workers & Pages** deinen Worker `pixelmonster` öffnen und dort den Reiter **Bindings** (oder **Settings → Bindings**) wählen.
2. **Add binding → D1 database** wählen.
3. Variable name: `DB` (genau so, in Großbuchstaben), Database: `pixelmonster`.
4. Speichern bzw. **Deploy** klicken.

## 5. Testen
Öffne im Browser `https://pixelmonster.DEIN-KONTONAME.workers.dev/ping`. Die genaue Adresse steht oben auf der Seite deines Workers.
Wenn dort `{"ok":true,"game":"pixelmonster"}` erscheint, läuft alles.

## 6. Im Spiel benutzen
- Schick mir die Adresse. Dann baue ich sie fest in die App ein, und deine Freunde müssen nur noch auf „Online gehen“ klicken.
- Oder trag sie selbst im Tab **🌐 Online** unter „Server-Adresse“ ein. Deine Freunde müssen dann dieselbe Adresse eintragen.

## Kosten
Der kostenlose Tarif erlaubt 100.000 Anfragen pro Tag. Ein Spieler braucht etwa 3 Anfragen pro Minute, solange das Spiel offen ist. Für dich und deine Freunde reicht das locker.
