import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  ActivityType,
  REST,
  Routes,
  ApplicationCommandOptionType,
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  getVoiceConnection,
} from '@discordjs/voice';
import play from 'play-dl';

const token = process.env.DISCORD_TOKEN;
const guildIdForCommands = process.env.GUILD_ID;

if (!token) {
  throw new Error('Missing DISCORD_TOKEN env var');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const musicStateByGuild = new Map();

const LoopMode = {
  Off: 'off',
  Track: 'track',
  Queue: 'queue',
};

function getOrCreateMusicState(guildId) {
  const existing = musicStateByGuild.get(guildId);
  if (existing) return existing;

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
  });

  const state = {
    player,
    queue: [],
    playing: false,
    nowPlaying: null,
    loopMode: LoopMode.Off,
  };

  player.on(AudioPlayerStatus.Idle, async () => {
    state.playing = false;
    if (state.loopMode === LoopMode.Track && state.nowPlaying?.url) {
      state.queue.unshift(state.nowPlaying.url);
    } else if (state.loopMode === LoopMode.Queue && state.nowPlaying?.url) {
      state.queue.push(state.nowPlaying.url);
    }
    await playNext(guildId);
  });

  musicStateByGuild.set(guildId, state);
  return state;
}

async function resolveToYouTubeUrl(queryOrUrl) {
  if (play.yt_validate(queryOrUrl) === 'video') return queryOrUrl;
  if (play.yt_validate(queryOrUrl) === 'playlist') return queryOrUrl;

  if (play.sp_validate(queryOrUrl) === 'track') {
    const track = await play.spotify(queryOrUrl);
    const search = await play.search(`${track.name} ${track.artists?.[0]?.name ?? ''}`, {
      limit: 1,
      source: { youtube: 'video' },
    });
    if (!search?.[0]?.url) throw new Error('No pude encontrar esa canción en YouTube');
    return search[0].url;
  }

  const search = await play.search(queryOrUrl, { limit: 1, source: { youtube: 'video' } });
  if (!search?.[0]?.url) throw new Error('No encontré resultados');
  return search[0].url;
}

async function resolveToYouTubeUrls(queryOrUrl) {
  if (play.yt_validate(queryOrUrl) === 'playlist') {
    const pl = await play.playlist_info(queryOrUrl, { incomplete: true });
    const videos = await pl.all_videos();
    return videos.map((v) => v.url).filter(Boolean);
  }

  if (play.sp_validate(queryOrUrl) === 'playlist' || play.sp_validate(queryOrUrl) === 'album') {
    const data = await play.spotify(queryOrUrl);
    const tracks = (typeof data?.all_tracks === 'function' ? await data.all_tracks() : data?.tracks) ?? [];

    const limitedTracks = tracks.slice(0, 50);
    const urls = [];

    for (const t of limitedTracks) {
      const search = await play.search(`${t.name} ${t.artists?.[0]?.name ?? ''}`, {
        limit: 1,
        source: { youtube: 'video' },
      });
      if (search?.[0]?.url) urls.push(search[0].url);
    }

    return urls;
  }

  return [await resolveToYouTubeUrl(queryOrUrl)];
}

async function playNext(guildId) {
  const state = getOrCreateMusicState(guildId);
  if (state.playing) return;

  const nextUrl = state.queue.shift();
  if (!nextUrl) return;

  const connection = getVoiceConnection(guildId);
  if (!connection) {
    state.queue = [];
    return;
  }

  const stream = await play.stream(nextUrl);
  const resource = createAudioResource(stream.stream, {
    inputType: stream.type === 'opus' ? StreamType.Opus : StreamType.Arbitrary,
  });

  state.nowPlaying = { url: nextUrl };
  state.playing = true;
  state.player.play(resource);
  connection.subscribe(state.player);
}

function ensureVoiceConnection(interactionOrMessage, voiceChannel) {
  const guildId = interactionOrMessage.guildId;
  const existingConnection = getVoiceConnection(guildId);
  const existingChannelId = existingConnection?.joinConfig?.channelId;
  if (existingConnection && existingChannelId && existingChannelId !== voiceChannel.id) {
    existingConnection.destroy();
  }

  return (
    getVoiceConnection(guildId) ??
    joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: interactionOrMessage.guild.voiceAdapterCreator,
      selfDeaf: true,
    })
  );
}

function queueSummary(queue, limit = 10) {
  if (!queue.length) return 'Cola vacía.';
  const items = queue.slice(0, limit).map((url, idx) => `${idx + 1}. ${url}`);
  const more = queue.length > limit ? `\n...y ${queue.length - limit} más` : '';
  return items.join('\n') + more;
}

let startTime = Date.now();

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  const m = minutes % 60;
  const s = seconds % 60;
  return `${days}d ${h}h ${m}m ${s}s`;
}

function updatePresence() {
  if (!client.user) return;
  const uptime = formatUptime(Date.now() - startTime);
  client.user.setPresence({
    activities: [
      {
        name: `Aura Hax | ${uptime}`,
        type: ActivityType.Playing,
      },
    ],
    status: 'online',
  });
}

client.once('ready', async () => {
  if (!client.user) return;

  updatePresence();
  setInterval(updatePresence, 15000);

  const commands = [
    {
      name: 'play',
      description: 'Reproduce música (YouTube/Spotify)',
      options: [
        {
          name: 'query',
          description: 'URL o búsqueda (puede ser playlist)',
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: 'search',
      description: 'Busca en YouTube y elige (top 5)',
      options: [
        {
          name: 'query',
          description: 'Texto de búsqueda',
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    { name: 'queue', description: 'Muestra la cola' },
    { name: 'nowplaying', description: 'Muestra lo que está sonando' },
    { name: 'pause', description: 'Pausa la música' },
    { name: 'resume', description: 'Reanuda la música' },
    { name: 'skip', description: 'Salta la canción actual' },
    { name: 'stop', description: 'Detiene la música y sale del canal' },
    { name: 'join', description: 'Hace que el bot entre a tu canal de voz' },
    { name: 'leave', description: 'Saca el bot del canal de voz' },
    { name: 'clear', description: 'Limpia la cola' },
    {
      name: 'remove',
      description: 'Elimina una canción por posición',
      options: [
        {
          name: 'position',
          description: 'Posición en la cola (1..n)',
          type: ApplicationCommandOptionType.Integer,
          required: true,
          min_value: 1,
        },
      ],
    },
    {
      name: 'loop',
      description: 'Loop: off / track / queue',
      options: [
        {
          name: 'mode',
          description: 'Modo de loop',
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: 'off', value: 'off' },
            { name: 'track', value: 'track' },
            { name: 'queue', value: 'queue' },
          ],
        },
      ],
    },
  ];

  const rest = new REST({ version: '10' }).setToken(token);
  try {
    console.log(`[startup] bot_user=${client.user.tag} bot_id=${client.user.id}`);
    console.log(`[startup] registering_commands scope=${guildIdForCommands ? 'guild' : 'global'} guildId=${guildIdForCommands ?? ''} count=${commands.length}`);
    if (guildIdForCommands) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildIdForCommands), { body: [] });
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildIdForCommands), {
        body: commands,
      });
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    }

    console.log('[commands] registered successfully');
  } catch (err) {
    console.error('[commands] failed to register:', err);
  }

  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guildId) return;

  const guildId = interaction.guildId;

  if (interaction.commandName === 'play') {
    const query = interaction.options.getString('query', true);
    const member = interaction.member;
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: 'Métete a un canal de voz primero.', ephemeral: true });
      return;
    }

    const permissions = voiceChannel.permissionsFor(interaction.guild.members.me);
    if (!permissions?.has('Connect') || !permissions?.has('Speak')) {
      await interaction.reply({
        content: 'No tengo permisos para entrar y hablar en ese canal (Connect/Speak).',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    try {
      const urls = await resolveToYouTubeUrls(query);
      const state = getOrCreateMusicState(guildId);
      state.queue.push(...urls);

      const connection = ensureVoiceConnection(interaction, voiceChannel);
      connection.subscribe(state.player);
      await playNext(guildId);

      await interaction.editReply({ content: `Agregado a la cola: ${urls[0]}${urls.length > 1 ? ` (+${urls.length - 1} más)` : ''}` });
    } catch (err) {
      console.error('[play] failed:', err);
      await interaction.editReply({ content: 'No pude reproducir eso. Revisa el link o intenta otra búsqueda.' });
    }

    return;
  }

  if (interaction.commandName === 'skip') {
    const state = getOrCreateMusicState(guildId);
    state.player.stop(true);
    await interaction.reply({ content: 'Skip.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'pause') {
    const state = getOrCreateMusicState(guildId);
    state.player.pause(true);
    await interaction.reply({ content: '⏸️ Pausado.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'resume') {
    const state = getOrCreateMusicState(guildId);
    state.player.unpause();
    await interaction.reply({ content: '▶️ Reanudado.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'queue') {
    const state = getOrCreateMusicState(guildId);
    await interaction.reply({ content: queueSummary(state.queue), ephemeral: true });
    return;
  }

  if (interaction.commandName === 'nowplaying') {
    const state = getOrCreateMusicState(guildId);
    await interaction.reply({ content: state.nowPlaying?.url ? `🎶 Now playing: ${state.nowPlaying.url}` : 'Nada sonando.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'clear') {
    const state = getOrCreateMusicState(guildId);
    state.queue = [];
    await interaction.reply({ content: '🧹 Cola limpiada.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'remove') {
    const state = getOrCreateMusicState(guildId);
    const pos = interaction.options.getInteger('position', true);
    const idx = pos - 1;
    if (idx < 0 || idx >= state.queue.length) {
      await interaction.reply({ content: 'Posición inválida.', ephemeral: true });
      return;
    }
    const removed = state.queue.splice(idx, 1)[0];
    await interaction.reply({ content: `🗑️ Eliminado: ${removed}`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'loop') {
    const state = getOrCreateMusicState(guildId);
    const mode = interaction.options.getString('mode', true);
    state.loopMode = mode;
    await interaction.reply({ content: `🔁 Loop: ${mode}`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'join') {
    const member = interaction.member;
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: 'Métete a un canal de voz primero.', ephemeral: true });
      return;
    }
    ensureVoiceConnection(interaction, voiceChannel);
    await interaction.reply({ content: '✅ Listo, estoy en tu canal.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'leave') {
    const connection = getVoiceConnection(guildId);
    connection?.destroy();
    await interaction.reply({ content: '👋 Me salí del canal.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'search') {
    const query = interaction.options.getString('query', true);
    await interaction.deferReply({ ephemeral: true });
    try {
      const results = await play.search(query, { limit: 5, source: { youtube: 'video' } });
      if (!results?.length) {
        await interaction.editReply({ content: 'No encontré resultados.' });
        return;
      }

      const list = results.map((r, i) => `${i + 1}. ${r.title} - ${r.url}`).join('\n');
      await interaction.editReply({ content: `Resultados:\n${list}\n\nUsa /play con el link que quieras.` });
    } catch (err) {
      console.error('[search] failed:', err);
      await interaction.editReply({ content: 'Error buscando.' });
    }
  }

  if (interaction.commandName === 'stop') {
    const state = getOrCreateMusicState(guildId);
    state.queue = [];
    state.player.stop(true);
    const connection = getVoiceConnection(guildId);
    connection?.destroy();
    await interaction.reply({ content: 'Música detenida.', ephemeral: true });
  }
});

client.login(token);
