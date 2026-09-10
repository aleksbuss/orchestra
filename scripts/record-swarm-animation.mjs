import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(__dirname, '../docs/assets/swarm-pipeline-animation.html');
const outDir = path.resolve(__dirname, '../docs/assets/recordings');
fs.mkdirSync(outDir, { recursive: true });

async function main() {
  console.log('Launching browser to capture animation...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1540, height: 860 },
    recordVideo: {
      dir: outDir,
      size: { width: 1540, height: 860 },
    },
  });

  const page = await context.newPage();
  await page.goto(`file://${htmlPath}`);

  // Wait 12 seconds to capture a full cycle of all 5 phases
  console.log('Recording 12 seconds of animation...');
  await page.waitForTimeout(12000);

  await context.close();
  await browser.close();

  // Find the recorded video file in outDir
  const files = fs.readdirSync(outDir).filter(f => f.endsWith('.webm'));
  if (files.length > 0) {
    const rawWebm = path.join(outDir, files[files.length - 1]);
    const outMp4 = path.resolve(__dirname, '../docs/assets/orchestra-swarm-pipeline.mp4');
    const outGif = path.resolve(__dirname, '../docs/assets/orchestra-swarm-pipeline.gif');

    console.log(`Converting ${rawWebm} to MP4 and GIF...`);
    // Convert to high-quality H.264 MP4 (faststart for instant web play)
    execSync(`ffmpeg -y -i "${rawWebm}" -c:v libx264 -pix_fmt yuv420p -movflags +faststart -r 30 "${outMp4}"`);
    // Convert to GIF (optimized for LinkedIn post/comments)
    execSync(`ffmpeg -y -i "${rawWebm}" -vf "fps=15,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 "${outGif}"`);

    console.log('Success! Created MP4 and GIF:');
    console.log(`- MP4: ${outMp4}`);
    console.log(`- GIF: ${outGif}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
