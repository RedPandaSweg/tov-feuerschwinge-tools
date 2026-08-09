# Feuerschwinge – Tools

Downtime- und Sessionverwaltung, Kampagnenwerkzeuge und Integrationen für
Tales of the Valiant: Feuerschwinge.

## Änderungen in 3.1.0

- Token-Presets für Actor-Besitzer: Bild, Tokenname, Scale, Breite und Höhe
  speichern, als Live-Vorschau bearbeiten und auch ohne Token-Konfigurationsrecht
  über eine aktive Spielleitung anwenden.
- Bilder in Chatnachrichten lassen sich per Klick in einer großen Bildansicht
  öffnen.
- Der Feuerschwinge-Chatstil deckt auch ausgeklappte Black-Flag-Karten,
  Würfelergebnisse, Menüs, Ziele, Effekte und Item-Piles-Transferzeilen ab.
- Creature-JSON erlaubt Save-Spells ohne Damage Parts und verlangt kein
  Signature Feature mehr.
- Combat-HUD-Waffensets werden bei Änderungen durch andere Clients aktualisiert.
- Verbesserte Behandlung von Währungsstapeln, Item-Piles-Wechselkursen,
  Kompendiumsynchronisation und Downtime-Gegenständen.

Das Modul benötigt `tov-feuerschwinge` ab Version 3.0.0. Beim ersten Start als
Spielleitung kopiert es Einstellungen und Dokument-Flags aus dem bisherigen
Namespace `tov-feuerschwinge` nach `tov-feuerschwinge-tools`. Die Quelldaten
werden nicht gelöscht. Ein versteckter Migrationsbericht wird als World-Setting
`namespaceMigrationReport` gespeichert.

Zugriffe auf den alten Namespace erzeugen standardmäßig einmalige Warnungen mit
Aufrufpfad in der Browser-Konsole. Die Warnungen können in den Client-
Einstellungen deaktiviert werden.
