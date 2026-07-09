import { gpx } from '@tmcw/togeojson';

export const setupImporter = (zoneId, inputId, buttonId, onImport) => {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  const button = document.getElementById(buttonId);

  zone.addEventListener('click', (e) => {
    if (e.target === button || button.contains(e.target)) return;
    input.click();
  });

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    input.click();
  });

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', () => {
    zone.classList.remove('dragover');
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0], onImport);
    }
  });

  input.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFile(e.target.files[0], onImport);
    }
  });
};

const handleFile = (file, callback) => {
  if (!file.name.toLowerCase().endsWith('.gpx')) {
    alert('Please upload a .gpx file');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const dom = new DOMParser().parseFromString(e.target.result, 'text/xml');
      const parseErrors = dom.querySelectorAll('parsererror');
      if (parseErrors.length > 0) {
        throw new Error('Invalid XML in GPX file');
      }
      const geoJson = gpx(dom);
      if (!geoJson.features || geoJson.features.length === 0) {
        throw new Error('No tracks found in GPX file');
      }
      callback(geoJson);
    } catch (err) {
      console.error('GPX parse error:', err);
      alert('Failed to parse GPX: ' + err.message);
    }
  };
  reader.readAsText(file);
};
