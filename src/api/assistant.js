// Routes de l'assistant : le fil (propre à chaque compte), les questions,
// la voix (VOX). Les appels au modèle et à VOX sont plafonnés par compte, par
// minute et par jour, et pour l'instance entière.
import { Debit, ErreurHttp } from '../../socle/src/index.js';
import { prendrePhoto } from '../assistant/photo.js';
import { relances } from '../assistant/index.js';
import { ErreurLiaison } from '../assistant/liaisons.js';
import { vide } from './schemas.js';

// Une panne de VOX ou du modèle dit ce qui ne va pas, sans rien d'interne.
async function relayer(fn) {
  try { return await fn(); } catch (e) {
    if (!(e instanceof ErreurLiaison)) throw e;
    throw new ErreurHttp(e.status === 499 ? 409 : e.status >= 500 ? 502 : e.status, e.message);
  }
}

export function routesAssistant(route, s) {
  const { assistant, liaisons, plafond, plafondVoix } = s;
  const parMinute = new Debit({ max: s.cfg.iaMinute });
  const voix = new Debit({ max: 20 });
  // Le Hub (jeton d'intégration) peut poser une question, comme un compte : son fil n'est pas gardé.
  const cle = ctx => ctx.acteur.compte || ctx.acteur.id;
  const qui = ctx => ctx.acteur.compte ? `compte:${ctx.acteur.compte}` : ctx.acteur.id;
  const payer = ctx => () => {
    if (!plafond.prendre(qui(ctx))) throw new ErreurHttp(429, 'Plafond journalier de l’assistant atteint : réessaie demain, les administrateurs sont prévenus.');
  };
  const payerVoix = ctx => () => {
    if (!plafondVoix.prendre(qui(ctx))) throw new ErreurHttp(429, 'Plafond journalier de la voix atteint : réessaie demain, les administrateurs sont prévenus.');
  };

  route.get('/api/assistant', async ctx => {
    const fil = assistant.fil(cle(ctx));
    return {
      fil, encours: assistant.occupe(cle(ctx)),
      ia: { prete: liaisons.iaPrete, modele: liaisons.modele || null },
      voix: await liaisons.etatVoix(),
      cerveau: { synapse: liaisons.synapsePrete, nom: liaisons.nomCerveau },
      relances: relances(prendrePhoto(s), fil),
      quota: { jour: s.cfg.iaJour, restant: plafond.restant(qui(ctx)) },
    };
  }, { role: 'lecture', jeton: true });

  route.post('/api/assistant/ask', ctx => {
    if (!parMinute.prendre(cle(ctx))) throw new ErreurHttp(429, 'Trop de questions d’affilée : attends une minute.');
    return relayer(() => assistant.demander(cle(ctx), ctx.corps.text, { voix: ctx.corps.voix === true, payer: payer(ctx) }));
  }, { role: 'lecture', jeton: true, corps: { text: { type: 'chaine', requis: true, min: 1, max: 2000 }, voix: { type: 'booleen' } } });

  route.post('/api/assistant/stop', ctx => ({ arrete: assistant.arreter(ctx.acteur.compte) }), { role: 'lecture', corps: vide });
  route.post('/api/assistant/nouvelle', ctx => { assistant.oublier(ctx.acteur.compte); return { ok: true }; }, { role: 'lecture', corps: vide });

  route.get('/api/assistant/voix', () => liaisons.etatVoix(), { role: 'lecture' });

  route.post('/api/assistant/voix/transcrire', ctx => {
    if (!voix.prendre(ctx.acteur.compte)) throw new ErreurHttp(429, 'Trop de transcriptions : attends une minute.');
    return relayer(() => liaisons.transcrire(ctx.brut, { payer: payerVoix(ctx) }));
  }, { role: 'lecture', brut: 'audio/', limite: 12 * 1048576 });

  route.post('/api/assistant/voix/dire', async ctx => {
    if (!voix.prendre(ctx.acteur.compte)) throw new ErreurHttp(429, 'Trop de lectures : attends une minute.');
    const { son, type } = await relayer(() => liaisons.dire(ctx.corps.text, { payer: payerVoix(ctx) }));
    ctx.res.writeHead(200, { 'Content-Type': type, 'Content-Length': son.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    ctx.res.end(son);
  }, { role: 'lecture', corps: { text: { type: 'chaine', requis: true, min: 1, max: 1500 } } });
}
