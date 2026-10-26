// Free check: the key works and the models we need are enabled.
import { meta } from '../src/meta.js';

const ids = (await meta.models.list()).data.map((m) => m.id);
for (const need of ['sam-3.1', 'muse-spark-1.3', 'muse-voice-transcribe-1.0']) {
  console.log(`${ids.includes(need) ? 'ok     ' : 'MISSING'} ${need}`);
}
