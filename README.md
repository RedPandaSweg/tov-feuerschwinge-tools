# Feuerschwinge – Tools

Downtime- und Sessionverwaltung, Kampagnenwerkzeuge und Integrationen für
Tales of the Valiant: Feuerschwinge.

Das Modul benötigt `tov-feuerschwinge` ab Version 3.0.0. Beim ersten Start als
Spielleitung kopiert es Einstellungen und Dokument-Flags aus dem bisherigen
Namespace `tov-feuerschwinge` nach `tov-feuerschwinge-tools`. Die Quelldaten
werden nicht gelöscht. Ein versteckter Migrationsbericht wird als World-Setting
`namespaceMigrationReport` gespeichert.

Zugriffe auf den alten Namespace erzeugen standardmäßig einmalige Warnungen mit
Aufrufpfad in der Browser-Konsole. Die Warnungen können in den Client-
Einstellungen deaktiviert werden.
