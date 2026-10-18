import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFisbText, flightCategory } from './text.js';

test('FIS-B text reports are classified with their station and time', () => {
  // Texts as uplinked (fisb-decode level-0 output of test group 30).
  const cases = [
    [
      'METAR KCEY 300835Z AUTO 29004KT 10SM 04/03 A3014 RMK AO1=\n',
      { kind: 'METAR', subtype: 'METAR', station: 'KCEY', issued: '300835' },
    ],
    [
      'SPECI KHTS 300759Z 32007KT 10SM BR OVC014 09/08 A2989 RMK AO2 T00890078  \n     $=\n',
      { kind: 'METAR', subtype: 'SPECI', station: 'KHTS', issued: '300759' },
    ],
    [
      'TAF.AMD KDAY 300702Z 3007/3106 33012KT P6SM OVC012\n',
      { kind: 'TAF', subtype: 'TAF.AMD', station: 'KDAY', issued: '300702' },
    ],
    [
      'TAF COR KPKB 300612Z 3006/3106 33007KT P6SM -RA BKN012\n',
      { kind: 'TAF', subtype: 'TAF COR', station: 'KPKB', issued: '300612' },
    ],
    [
      'WINDS TUL 301800Z  FT 3000 6000      9000\n',
      { kind: 'WINDS', subtype: null, station: 'TUL', issued: '301800' },
    ],
    [
      'PIREP MEM 300810Z MEM UA /OV MEM360002/TM 0810/FLDURC/TP B757/SK BKN020\n',
      { kind: 'PIREP', subtype: 'UA', station: 'MEM', issued: '300810' },
    ],
    [
      'NOTAM-D KEYE.10/028 010100Z !EYE 10/028 EYE RWY 03/21 CLSD 2011010100-2011011100\n',
      { kind: 'NOTAM', subtype: 'D', station: 'KEYE', issued: '010100' },
    ],
    [
      'AIRMET KCHI 300231 CHIT WA 300245\nAIRMET TANGO FOR TURB AND LLWS\n',
      { kind: 'AIRMET', subtype: null, station: 'KCHI', issued: '300231' },
    ],
    [
      'SUA 301645 5707541|24145|W|B|AR646|2010301645|2010301730|240|260|A|Y||||\n',
      { kind: 'SUA', subtype: null, station: null, issued: '301645' },
    ],
  ];
  for (const [text, expected] of cases)
    assert.deepEqual(classifyFisbText(text), expected, text);
  assert.equal(classifyFisbText('hello').kind, 'OTHER');
  assert.equal(classifyFisbText(null).kind, 'OTHER');
});

test('flight category follows the FAA ceiling and visibility limits', () => {
  const metar = (body) => `METAR KXXX 300835Z ${body} A3014 RMK AO2`;
  assert.equal(flightCategory(metar('10SM CLR')), 'VFR');
  assert.equal(flightCategory(metar('10SM SCT010 BKN035')), 'VFR');
  assert.equal(flightCategory(metar('10SM BKN030')), 'MVFR');
  assert.equal(flightCategory(metar('5SM BR SCT250')), 'MVFR');
  assert.equal(flightCategory(metar('P6SM OVC009')), 'IFR');
  assert.equal(flightCategory(metar('2 1/2SM BR FEW010')), 'IFR');
  assert.equal(flightCategory(metar('1/2SM FG VV002')), 'LIFR');
  assert.equal(flightCategory(metar('M1/4SM FG')), 'LIFR');
  assert.equal(flightCategory(metar('10SM OVC004')), 'LIFR');
  // Cloud groups in remarks do not count.
  assert.equal(
    flightCategory('METAR KXXX 300835Z 10SM CLR A3014 RMK OVC002'),
    'VFR',
  );
  assert.equal(flightCategory('METAR KXXX 300835Z AUTO 29004KT A3014'), null);
});
