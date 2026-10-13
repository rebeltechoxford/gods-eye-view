import * as Cesium from 'cesium';

const COLORS = Object.freeze({
  friendly: '#64c4ff',
  hostile: '#ff6b66',
  neutral: '#70e4a4',
  unknown: '#f0cd70',
  marker: '#f0cd70',
});

/** Deliberately separate from GEV's public-data layer registry and share links. */
export function createCotOverlay(viewer) {
  const dataSource = new Cesium.CustomDataSource('Local TAK contacts');
  let disposed = false;
  void viewer.dataSources.add(dataSource).then(() => {
    if (disposed) viewer.dataSources.remove(dataSource, true);
  }).catch((error) => console.warn('[TAK] Layer unavailable', error));

  return {
    render(contacts, isStale) {
      if (disposed) return;
      dataSource.entities.removeAll();
      for (const contact of contacts) {
        const faded = isStale(contact);
        const color = Cesium.Color.fromCssColorString(
          COLORS[contact.affiliation] || COLORS.unknown,
        ).withAlpha(faded ? 0.55 : 1);
        const position = Cesium.Cartesian3.fromDegrees(contact.lon, contact.lat);
        dataSource.entities.add({
          id: 'tak:' + contact.uid,
          name: contact.callsign,
          position,
          point: {
            pixelSize: faded ? 8 : 12,
            color,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: contact.callsign,
            font: '600 12px sans-serif',
            fillColor: color,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -22),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: {
            cotUid: contact.uid,
            cotType: contact.type,
            affiliation: contact.affiliation,
            stale: faded,
            source: 'LOCAL_COT_IMPORT',
          },
        });
      }
      viewer.scene.requestRender();
    },
    focus(uid) {
      if (disposed) return;
      const entity = dataSource.entities.getById('tak:' + uid);
      if (!entity) return;
      viewer.selectedEntity = entity;
      void viewer.flyTo(entity, { duration: 1.2 }).catch((error) =>
        console.warn('[TAK] Cannot focus contact', error));
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      viewer.dataSources.remove(dataSource, true);
    },
  };
}
