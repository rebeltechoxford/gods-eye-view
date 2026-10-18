# Local receivers

The Local ADS-B layer draws aircraft heard by your own receivers. It has two
inputs, and it can use both at once. The browser SDR can also listen to
aircraft voice: see [Listening to aircraft (airband)](#listening-to-aircraft-airband).

| Input        | What it is                                                                                                                          | Bands                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Browser SDR  | A USB RTL-SDR opened by the browser through WebUSB (Radio panel, Local RTL-SDR card). Decodes in the page; also hears airband.      | 1090 MHz; airband    |
| Decoder feed | The `aircraft.json` served by a decoder you run: dump1090-fa, readsb or tar1090 (1090 MHz), or dump978-fa + skyaware978 (978 MHz). | 1090 MHz, 978 MHz UAT |

Aircraft from both inputs are merged by ICAO address. The newest position
wins, and the click card names every band and source that heard the aircraft
in the last 60 s. Aircraft heard only on 978 MHz UAT draw with a thin ring.

The same 978 MHz receiver also hears FIS-B weather and NOTAMs from FAA
ground stations; the FIS-B Weather layer reads them from dump978-fa's raw port
([FIS-B Weather](FISB.md)).

Local aircraft usually lead their public twins. The public Flights layer
renders positions about one poll interval (~30 s) behind so it can interpolate
smoothly between fixes, while local receiver aircraft are shown as heard. An
aircraft in both layers therefore draws twice, the magenta local marker ahead
of the public one; both markers are drawn on purpose.

## Which to use

- **One plain RTL-SDR dongle, desktop Chrome or Edge:** use the browser SDR.
  Nothing else to install.
- **A dual-band board, a Raspberry Pi feeder, or a dongle already used by a
  decoder:** use a decoder feed. A USB dongle can be opened by only one program
  at a time, so a dongle that dump1090 or dump978 owns cannot also be opened by
  the browser.

## Configuring feeds

Feeds are set in the server environment only (`.env`), never in the browser:

```sh
LOCAL_RECEIVER_FEEDS=1090=http://localhost:8080/data/aircraft.json,978=http://localhost:8978/data/aircraft.json
```

Each entry is `band=url`, where `band` is `1090` or `978`. The URL must:

- use `http` or `https`;
- point at loopback, a private (RFC1918) address, `localhost` or a `*.local`
  name. Public addresses, link-local addresses (including `169.254.169.254`),
  IPv6 and other host names are refused;
- have a path ending in `aircraft.json`, with no credentials, query or
  fragment.

An entry that breaks a rule is logged when the server starts, shown as
`invalid` and never fetched. Restart the server after changing the value.

The server reads every feed about once a second while the Local ADS-B layer is
on. A feed is `live`, `stale` (its own `now` is more than 10 s old, usually a
stopped decoder), `unreachable` or `invalid`. The Layers panel row and the
Local RTL-SDR card show these states.

## Example: dump1090-fa and dump978-fa on macOS or Linux

Write each decoder's JSON to a directory, then serve the directory on
localhost. Each command keeps running, so start each in its own terminal:

```sh
# 1090 MHz
dump1090-fa --device-index 0 --write-json /tmp/adsb1090
python3 -m http.server 8080 --bind 127.0.0.1 --directory /tmp/adsb1090

# 978 MHz UAT: dump978-fa decodes, skyaware978 writes aircraft.json
dump978-fa --sdr driver=rtlsdr,rtl=1 --raw-port 30978
skyaware978 --connect localhost:30978 --json-dir /tmp/adsb978
python3 -m http.server 8978 --bind 127.0.0.1 --directory /tmp/adsb978
```

```sh
LOCAL_RECEIVER_FEEDS=1090=http://localhost:8080/aircraft.json,978=http://localhost:8978/aircraft.json
```

A board with two identical-serial channels, such as the Nooelec FlyCatcher,
cannot be told apart by serial number. Select each channel by index:
`--device-index <n>` for dump1090-fa and `--sdr driver=rtlsdr,rtl=<n>` for
dump978-fa. `rtl_test` lists the indexes.

A tar1090 or readsb install on a Raspberry Pi already serves
`http://<pi-address>/tar1090/data/aircraft.json`. Use the Pi's private address
or its `.local` name.

## Listening to aircraft (airband)

The Local RTL-SDR card has an **AIR** mode for aircraft and air traffic
control voice on 118.000–136.975 MHz. It runs entirely in the browser with a
USB RTL-SDR: no internet connection, server or other software is needed.

1. Open the Radio panel, select **AIR** in the Local RTL-SDR card and press
   **CONNECT** (desktop Chrome or Edge).
2. The receiver starts on 121.500 MHz, the international guard and emergency
   frequency. Type the actual carrier frequency in **AIR CARRIER MHZ**
   (three decimals, for example `118.700`) and press **TUNE** or Enter. The field also suggests
   122.750 (air-to-air) and 123.025 (helicopter air-to-air).
3. **◀ 25 KHZ** and **25 KHZ ▶** step one 25 kHz channel down or up.
4. Find your local tower, CTAF, approach and ATIS frequencies on the
   airport's chart or in its airport directory entry; they differ per airport.

**Squelch.** Between transmissions an AM receiver plays loud hiss. The
**SQUELCH** slider mutes the audio until the channel's signal-to-noise ratio
reaches the threshold (0–30 dB; 0 turns squelch off). Receiver noise reads
about 0–1 dB, and the default 6 dB opens on a readable transmission. Raise it
if noise or a nearby interferer keeps opening it; lower it if weak aircraft are
cut off. The squelch stays open for 300 ms after a signal drops so the end of a
sentence is not chopped. The setting is remembered in the browser.

**Antenna.** Airband wants a vertical antenna about 60 cm long (a quarter wave
at 120–130 MHz) or a purpose-made airband antenna, as high and clear as you
can get it. A 1090 MHz ADS-B antenna, including the short whip of a
dual-band ADS-B board, is a poor match at 120 MHz: expect only nearby or
airborne transmitters. Ground stations (tower, ground, ATIS) are much weaker
than aircraft overhead.

**What it does and does not do.** Airband is AM only. The receiver tunes 250
kHz above the channel so the RTL-SDR's DC spike stays off it, and filters a
10 kHz channel. Entry is the actual carrier frequency, rounded to 1 kHz.
**8.33 kHz channel names are not converted:** channel `118.005` uses a
`118.000 MHz` carrier; entering `118.005` here instead tunes `118.005 MHz`.
See the [EUROCONTROL channel table](https://www.eurocontrol.int/archive_download/all/node/10364).
The fixed 10 kHz bandwidth and 1 kHz tuning resolution are not full 8.33 kHz
channel support. Gain is per mode (AUTO by default for airband). Airband shares
the tuner with FM and Local ADS-B, so turning on the Local ADS-B layer switches
the receiver to 1090 MHz, and local airband audio and internet radio stop each
other.

**Without a receiver: LiveATC.** The AIR help text links to
[LiveATC.net](https://www.liveatc.net/), which streams many towers and
approach controls over the internet. It opens in its own tab: LiveATC's terms
do not allow its streams to be played inside another application, so GEV only
links to it. It needs the internet and is refused under [EMCON](TAK_EMCON.md).

**Legal note.** In the United States, listening to aviation voice
communications is legal. Do not record and rebroadcast or publish what you
hear, or use it for commercial gain, without checking the rules that apply to
you; some countries restrict listening itself. Follow your local law.
