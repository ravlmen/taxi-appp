# Taxi Koblížek

Responzivní aplikace Taxi Koblížek pro zákaznické objednávky a mobilní panel řidičů.

## Spuštění

```sh
npm install
npm run dev
```

### Otevření na mobilu

Počítač i mobil připojte ke stejné Wi-Fi síti. Na počítači spusťte `ipconfig` a najděte jeho IPv4 adresu v části aktivního síťového adaptéru. V mobilním prohlížeči otevřete `http://ADRESA-POČÍTAČE:5173` (například `http://192.168.1.25:5173`). Nepoužívejte `localhost` — ten na mobilu označuje samotný telefon. Pokud se stránka neotevře, povolte Node.js ve Windows Firewallu pro soukromé sítě.

## Platba kartou

K placení kartou se používá Stripe Checkout. Údaje o kartě se zadávají na zabezpečené stránce Stripe; aplikace je nezpracovává ani neukládá. Po potvrzení objednávky se vypočte cena na serveru, zákazník zaplatí ihned a server ověří stav platby u Stripe před uložením jízdy do databáze a zpřístupněním řidičům.

Pro aktivaci vytvořte lokální soubor `.env` podle `.env.example` a vložte do něj Stripe tajný klíč (`STRIPE_SECRET_KEY`). Začněte testovacím klíčem `sk_test_` ze svého Stripe účtu. Tajný klíč nikdy nevkládejte do klientského kódu ani nesdílejte. `APP_BASE_URL` musí odpovídat adrese aplikace, například `http://localhost:5173` při vývoji nebo veřejné HTTPS adrese při nasazení. Poté spusťte `npm run dev`; vývojový příkaz spustí frontend i server plateb. Platby v testovacím režimu nejsou skutečné. Produkční provoz vyžaduje aktivovaný Stripe účet, živý klíč, HTTPS a nasazení serveru s bezpečně nastavenými proměnnými prostředí.

## Aplikace pro řidiče

Řidiči se přihlašují na `/ridic`. Při místním vývoji je připraven jen účet majitele `majitel` / `1611`; řidiče nastavte v `.env`. Účet majitele navíc zobrazuje trvalý počet dokončených jízd všech řidičů podle SQLite databáze. Slabá vývojová hesla jsou určená pouze pro místní vývoj a nesmí se používat na veřejném serveru. Pro nasazení nastavte v `.env` pro všechny tři řidiče vlastní uživatelská jména a hesla o délce alespoň 12 znaků (`DRIVER_1_USERNAME`/`DRIVER_1_PASSWORD`, `DRIVER_2_USERNAME`/`DRIVER_2_PASSWORD`, `DRIVER_3_USERNAME`/`DRIVER_3_PASSWORD`); jména a telefonní čísla lze nastavit přes `DRIVER_1_NAME`/`DRIVER_1_PHONE`, `DRIVER_2_NAME`/`DRIVER_2_PHONE` a `DRIVER_3_NAME`/`DRIVER_3_PHONE`. V produkčním režimu jsou vývojové přihlašovací údaje vypnuté. Po změně `.env` restartujte server.

Zákazník se přihlašuje jménem a telefonem; jméno se zadává jen při přihlášení a objednávka ho přebírá z přihlášené relace. Server ověří formát českého 9místného nebo mezinárodního čísla a přístup povolí až po zadání jednorázového SMS kódu. Ověřené číslo se předvyplní pro objednávku a zákazník ho nemusí opakovaně zadávat. SMS odesílá Twilio. Nastavte `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` a aktivní SMS odesílací číslo `TWILIO_FROM_NUMBER` ve formátu E.164 v lokálním `.env`; nikdy nevkládejte přístupový token do klientského kódu ani do chatu. Pro oznámení řidičům nastavte také jejich příjemce `DRIVER_1_PHONE`, `DRIVER_2_PHONE` a `DRIVER_3_PHONE` ve formátu E.164. Bez SMS konfigurace vývojový režim zobrazí testovací kód na obrazovce; produkční přihlášení vyžaduje nakonfigurované Twilio. Twilio může vyžadovat ověření příjemců nebo odesílacího čísla podle typu účtu a země. SMS přihlašovací kód se posílá zákazníkovi, nová objednávka všem třem řidičům a přijetí nebo odmítnutí všemi řidiči zákazníkovi. Po změně `.env` restartujte server. Objednávka používá jméno zadané při přihlášení.

Objednávky se ukládají do SQLite souboru `data/taxi-koblizek.sqlite` (lze změnit pomocí `DATABASE_PATH`). Nové jízdy se řidičům obnovují každých 5 sekund. Panel zobrazuje trasu v mapě, vzdálenost, cenu, čas objednání a způsob platby. Telefon zákazníka vidí všichni přihlášení řidiči už u nové jízdy; jméno zákazníka se zobrazí až po přijetí. Řidič si může povolit oznámení prohlížeče o nových jízdách. Zákazník vidí stav objednávky a může si zapnout oznámení o jejím přijetí nebo odmítnutí všemi řidiči. Tato oznámení fungují jen po dobu, kdy je aplikace otevřená v prohlížeči; pro upozornění po zavření je potřeba samostatně nasadit Web Push a HTTPS. Přijetí probíhá atomicky: jízdu získá pouze první řidič, který ji přijme. Řidič může jízdu přeskočit a po přijetí měnit její stav. Data databáze se nesdílejí do zdrojového repozitáře.

Toto je základ pro ověření pracovního postupu, nikoli hotová veřejná produkční služba. Před skutečným provozem na internetu nasazujte přes HTTPS, nastavte bezpečná tajemství a zálohování databáze a doplňte zásady ochrany osobních údajů, retenční lhůty a produkční monitoring. Souborová SQLite databáze je určena pro jednu instanci serveru; více serverů vyžaduje sdílenou databázi.

## Mapa a cena

- Interaktivní mapa a dlaždice mapy: [OpenStreetMap](https://www.openstreetmap.org/copyright), vykreslení pomocí Leafletu.
- Vyhledání úplných adres: oficiální vyhledávací služba ČÚZK nad registrem [RÚIAN](https://vdp.cuzk.gov.cz/vdp/ruian/adresnimista).
- Převod polohy GPS na adresu: veřejná služba [Nominatim](https://nominatim.org/) podle [pravidel používání](https://operations.osmfoundation.org/policies/nominatim/).
- Trasa autem a její délka: veřejný demo router [OSRM](https://project-osrm.org/).
- Cena se počítá z délky skutečné silniční trasy: **80 Kč nástupní sazba + 32 Kč za kilometr**. Cena je zaokrouhlena na celé koruny.

Začněte psát alespoň tři znaky města, ulice nebo adresy včetně čísla domu a návrhy se automaticky zobrazí. Vyberte adresní místo z nabídky. Vyhledávání probíhá nad oficiálním registrem RÚIAN pro celou Českou republiku; návrhy se načítají po 30 položkách a další se průběžně zobrazují při posouvání seznamu, případně tlačítkem **Načíst další adresy**. Tak lze procházet všechny odpovídající výsledky, aniž by se celý registr stahoval najednou. Podporuje také vyhledávání bez české diakritiky. Ručně napsaný text bez vybraného návrhu nelze použít. Po výběru obou míst zvolte **Vypočítat trasu a cenu**. Mapa následně zobrazí trasu a serverem vypočtenou cenu; stejná cenová nabídka se použije při platbě kartou. Je nutné připojení k internetu.

Řidičská aplikace používá individuální účty nastavené provozovatelem. Objednávky se zobrazují společně; jízdu dostane řidič, který ji první přijme. Při hotovostní objednávce je zákazníkovi zobrazena cena a jízda se uloží do databáze.

Mapové dlaždice OpenStreetMap, vyhledávání RÚIAN a výpočet trasy OSRM využívají veřejné služby a vyžadují připojení k internetu. Platba kartou je zpracována přes Stripe. Když Stripe není nastaven, volba karty zůstane vypnutá a zákazník může objednat hotově.

## Ověření

```sh
npm run build
npm run lint
node --test src/priceCalculator.test.mjs
node --test server/rideStore.test.mjs
```
