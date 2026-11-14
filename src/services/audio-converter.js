// audio-converter.js — автоматическая конвертация загружаемых аудиозаписей в MP3 для экономии памяти сервера
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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

module.exports = {
  convertToMp3
};
