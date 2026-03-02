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
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const musicStateByGuild = new Map();

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
  };

  player.on(AudioPlayerStatus.Idle, async () => {
    state.playing = false;
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

  state.playing = true;
  state.player.play(resource);
  connection.subscribe(state.player);
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
          description: 'URL o búsqueda',
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: 'skip',
      description: 'Salta la canción actual',
    },
    {
      name: 'stop',
      description: 'Detiene la música y sale del canal',
    },
  ];

  const rest = new REST({ version: '10' }).setToken(token);
  try {
    if (guildIdForCommands) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildIdForCommands), {
        body: commands,
      });
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    }
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
      const url = await resolveToYouTubeUrl(query);
      const state = getOrCreateMusicState(guildId);
      state.queue.push(url);

      const existingConnection = getVoiceConnection(guildId);
      const existingChannelId = existingConnection?.joinConfig?.channelId;
      if (existingConnection && existingChannelId && existingChannelId !== voiceChannel.id) {
        existingConnection.destroy();
      }

      const connection =
        getVoiceConnection(guildId) ??
        joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId,
          adapterCreator: interaction.guild.voiceAdapterCreator,
          selfDeaf: true,
        });

      connection.subscribe(state.player);
      await playNext(guildId);

      await interaction.editReply({ content: `Agregado a la cola: ${url}` });
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

  if (interaction.commandName === 'stop') {
    const state = getOrCreateMusicState(guildId);
    state.queue = [];
    state.player.stop(true);
    const connection = getVoiceConnection(guildId);
    connection?.destroy();
    await interaction.reply({ content: 'Música detenida.', ephemeral: true });
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guildId) return;

  const content = message.content.trim();
  const guildId = message.guildId;

  if (content.startsWith('!play ')) {
    const query = content.slice(6).trim();
    if (!query) {
      await message.reply('Uso: `!play <url o nombre>`');
      return;
    }

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      await message.reply('Métete a un canal de voz primero.');
      return;
    }

    const permissions = voiceChannel.permissionsFor(message.guild.members.me);
    if (!permissions?.has('Connect') || !permissions?.has('Speak')) {
      await message.reply('No tengo permisos para entrar y hablar en ese canal (Connect/Speak).');
      return;
    }

    try {
      const url = await resolveToYouTubeUrl(query);
      const state = getOrCreateMusicState(guildId);
      state.queue.push(url);

      const existingConnection = getVoiceConnection(guildId);
      const existingChannelId = existingConnection?.joinConfig?.channelId;
      if (existingConnection && existingChannelId && existingChannelId !== voiceChannel.id) {
        existingConnection.destroy();
      }

      const connection =
        getVoiceConnection(guildId) ??
        joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId,
          adapterCreator: message.guild.voiceAdapterCreator,
          selfDeaf: true,
        });

      connection.subscribe(state.player);
      await playNext(guildId);

      await message.reply(`🎵 Agregado: ${url}`);
    } catch (err) {
      console.error('[play:text] failed:', err);
      await message.reply('No pude reproducir eso. Revisa el link o intenta otra búsqueda.');
    }
    return;
  }

  if (content === '!skip') {
    const state = getOrCreateMusicState(guildId);
    state.player.stop(true);
    await message.reply('⏭️ Skip.');
    return;
  }

  if (content === '!stop') {
    const state = getOrCreateMusicState(guildId);
    state.queue = [];
    state.player.stop(true);
    const connection = getVoiceConnection(guildId);
    connection?.destroy();
    await message.reply('⏹️ Música detenida.');
    return;
  }
});

client.login(token);
