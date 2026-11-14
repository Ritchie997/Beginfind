// audio-converter.js — автоматическая конвертация загружаемых аудиозаписей в MP3 для экономии памяти сервера
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function isFfmpegAvailable() {
  try {
    const res = spawnSync('ffmpeg', ['-version'], { timeout: 3000 });
    return res.status === 0;
  } catch (e) {
    return false;
  }
}

/**
 * Конвертирует аудиофайл в MP3 с использованием ffmpeg.
 * Если файл уже MP3 (по расширению и формату), конвертация пропускается.
 * Исходный не-MP3 файл удаляется после успешного кодирования.
 * 
 * @param {string} inputPath - Полный путь к файлу на диске
 * @returns {Promise<{ converted: boolean, outputPath: string, filename: string, size: number, format: string }>}
 */
async function convertToMp3(inputPath) {
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error('Файл для конвертации не найден: ' + inputPath);
  }

  const ext = path.extname(inputPath).toLowerCase();
  const stat = await fs.promises.stat(inputPath);

  // mp3 в mp3 не переделываем
  if (ext === '.mp3') {
    return {
      converted: false,
      outputPath: inputPath,
      filename: path.basename(inputPath),
      size: stat.size,
      format: 'mp3'
    };
  }

  if (!isFfmpegAvailable()) {
    console.warn('[AudioConverter] ⚠️ ffmpeg не найден в PATH на сервере! Для работы конвертации аудио в MP3 установите ffmpeg: sudo apt install -y ffmpeg');
    return {
      converted: false,
      outputPath: inputPath,
      filename: path.basename(inputPath),
      size: stat.size,
      format: ext.replace('.', ''),
      ffmpegMissing: true
    };
  }

  const dir = path.dirname(inputPath);
  const baseName = path.basename(inputPath, ext);
  const outputFilename = `${baseName}.mp3`;
  const outputPath = path.join(dir, outputFilename);

  return new Promise((resolve) => {
    // Параметры ffmpeg:
    // -y: перезапись существующего выходного файла
    // -i: входной аудиофайл
    // -vn: игнорировать видеопотоки (например, у webm/m4a/mp4)
    // -codec:a libmp3lame: кодек MP3
    // -q:a 2: VBR битрейт высокого качества (~190-250 kbps) с компактным размером
    const proc = spawn('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-vn',
      '-codec:a', 'libmp3lame',
      '-q:a', '2',
      outputPath
    ]);

    let stderr = '';
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      console.warn('[AudioConverter] ffmpeg spawn failed, keeping original file:', err.message);
      resolve({
        converted: false,
        outputPath: inputPath,
        filename: path.basename(inputPath),
        size: stat.size,
        format: ext.replace('.', '')
      });
    });

    proc.on('close', async (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        try {
          const newStat = await fs.promises.stat(outputPath);
          // Удаляем исходный тяжелый файл (например .wav, .flac) для экономии места на сервере
          await fs.promises.unlink(inputPath).catch(() => {});
          resolve({
            converted: true,
            outputPath,
            filename: outputFilename,
            size: newStat.size,
            format: 'mp3'
          });
        } catch (e) {
          resolve({
            converted: false,
            outputPath: inputPath,
            filename: path.basename(inputPath),
            size: stat.size,
            format: ext.replace('.', '')
          });
        }
      } else {
        console.warn('[AudioConverter] ffmpeg exited with code ' + code + ':', stderr.slice(-300));
        resolve({
          converted: false,
          outputPath: inputPath,
          filename: path.basename(inputPath),
          size: stat.size,
          format: ext.replace('.', '')
        });
      }
    });
  });
}

const WIN1252_REVERSE = {
  8364: 0x80, 8218: 0x82, 402: 0x83, 8222: 0x84, 8230: 0x85, 8224: 0x86, 8225: 0x87,
  710: 0x88, 8240: 0x89, 352: 0x8A, 8249: 0x8B, 338: 0x8C, 381: 0x8E, 8216: 0x91,
  8217: 0x92, 8220: 0x93, 8221: 0x94, 8226: 0x95, 8211: 0x96, 8212: 0x97, 732: 0x98,
  8482: 0x99, 353: 0x9A, 8250: 0x9B, 339: 0x9C, 382: 0x9E, 376: 0x9F
};

/**
 * Восстанавливает оригинальное имя файла / заголовок, если оно было повреждено
 * latin1/windows-1252 перекодировкой в multipart-заголовках multer/busboy.
 *
 * @param {string} str - Исходная строка имени файла или заголовка
 * @returns {string} - Декодированная UTF-8 строка
 */
function decodeOriginalName(str) {
  if (!str || typeof str !== 'string') return '';
  const hasHighBytes = Array.from(str).some((c) => c.charCodeAt(0) >= 128);
  if (!hasHighBytes) return str;
  if (!/[ÐÑ]/.test(str)) {
    return str;
  }
  try {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code <= 255) {
        bytes.push(code);
      } else if (WIN1252_REVERSE[code]) {
        bytes.push(WIN1252_REVERSE[code]);
      } else {
        return str;
      }
    }
    const candidate = Buffer.from(bytes).toString('utf8');
    if (!candidate.includes('\uFFFD') && /[а-яёА-ЯЁ]/.test(candidate)) {
      return candidate;
    }
  } catch (_) {}
  return str;
}

module.exports = {
  convertToMp3,
  isFfmpegAvailable,
  decodeOriginalName
};
