> DEMO-DATEN: frei erfundener Beispielinhalt zum Ausprobieren der Plattform. Vor dem produktiven Einsatz löschen.

# Betriebskonzept Rechenzentrum (Beispiel)

## Incident Management

Störungen werden nach Priorität klassifiziert. Bei Priorität 1 (Totalausfall eines kritischen Dienstes) beträgt die Reaktionszeit 30 Minuten und die Wiederherstellungszeit 4 Stunden. Bei Priorität 2 beträgt die Reaktionszeit 2 Stunden und die Wiederherstellungszeit 8 Stunden. Bei Priorität 3 beträgt die Reaktionszeit 8 Stunden, bei Priorität 4 ein Werktag. Die Servicezeiten gelten rund um die Uhr für Priorität 1 und werktags von 7 bis 19 Uhr für alle anderen Prioritäten.

| Priorität | Beschreibung                   | Reaktionszeit | Wiederherstellung |
| --------- | ------------------------------ | ------------- | ----------------- |
| 1         | Totalausfall kritischer Dienst | 30 Minuten    | 4 Stunden         |
| 2         | Wesentliche Einschränkung      | 2 Stunden     | 8 Stunden         |
| 3         | Geringe Einschränkung          | 8 Stunden     | 3 Werktage        |
| 4         | Anfrage ohne Einschränkung     | 1 Werktag     | nach Vereinbarung |

## Change Management

Jede Änderung wird über das Change Advisory Board (CAB) freigegeben. Standardänderungen sind vorab genehmigt, Notfalländerungen werden nachträglich dokumentiert. Wartungsfenster liegen in der Nacht von Samstag auf Sonntag.

## Service Desk

Der Service Desk ist werktags von 7 bis 19 Uhr telefonisch und per E-Mail erreichbar. Außerhalb dieser Zeit nimmt eine Rufbereitschaft Störungen der Priorität 1 an.

## Monitoring und Reporting

Alle Systeme werden rund um die Uhr überwacht. Schwellwertüberschreitungen erzeugen automatisch Tickets. Der Auftraggeber erhält monatlich einen Servicebericht mit Verfügbarkeit, Störungsstatistik und Maßnahmen zur kontinuierlichen Verbesserung.

## Eskalation

Stufe 1 ist der Service Desk, Stufe 2 das zuständige Fachteam, Stufe 3 die Servicemanagerin oder der Servicemanager. Bei Verletzung einer Wiederherstellungszeit wird automatisch eine Stufe höher eskaliert.
