package io.casthub.tv

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView

/** 全屏播放页：ExoPlayer 拉流，status 每 1s 推送 + 状态变化立即推送。 */
class PlayerActivity : AppCompatActivity(), TvWsServer.PlayerController {
    companion object {
        private const val TAG = "PlayerActivity"
        private const val EXTRA_URL = "extra_url"
        private const val EXTRA_TITLE = "extra_title"
        private const val EXTRA_MIME = "extra_mime"

        fun launch(context: Context, url: String, title: String, mimeType: String) {
            val intent = Intent(context, PlayerActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(EXTRA_URL, url)
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_MIME, mimeType)
            }
            context.startActivity(intent)
        }
    }

    private lateinit var playerView: PlayerView
    private lateinit var player: ExoPlayer
    private val uiHandler = Handler(Looper.getMainLooper())
    private val statusTicker = object : Runnable {
        override fun run() {
            if (player.isPlaying) pushStatus("playing")
            uiHandler.postDelayed(this, 1000L)
        }
    }

    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private val audioFocusListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        if (focusChange == AudioManager.AUDIOFOCUS_LOSS) {
            player.pause()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_player)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemUi()

        playerView = findViewById(R.id.playerView)
        player = ExoPlayer.Builder(this).build()
        playerView.player = player
        playerView.useController = false

        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                when (playbackState) {
                    Player.STATE_BUFFERING -> pushStatus("buffering")
                    Player.STATE_READY -> pushStatus(if (player.isPlaying) "playing" else "paused")
                    Player.STATE_ENDED -> {
                        pushStatus("idle")
                        finish()
                    }
                    Player.STATE_IDLE -> Unit
                }
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                pushStatus(
                    if (isPlaying) "playing"
                    else if (player.playbackState == Player.STATE_READY) "paused"
                    else "buffering"
                )
            }
        })

        loadMedia(intent)
        requestAudioFocus()
        TvWsServer.instance?.attachController(this)
        uiHandler.postDelayed(statusTicker, 1000L)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent != null) {
            setIntent(intent)
            loadMedia(intent)
        }
    }

    private fun loadMedia(intent: Intent) {
        val url = intent.getStringExtra(EXTRA_URL) ?: return
        val mimeType = intent.getStringExtra(EXTRA_MIME) ?: ""
        val builder = MediaItem.Builder().setUri(Uri.parse(url))
        if (mimeType.isNotEmpty()) builder.setMimeType(mimeType)
        player.setMediaItem(builder.build())
        player.playWhenReady = true
        player.prepare()
    }

    private fun pushStatus(state: String) {
        val duration = if (player.duration > 0) player.duration else 0L
        val position = player.currentPosition.coerceAtLeast(0L)
        TvWsServer.instance?.sendStatus(Protocol.status(state, position, duration))
    }

    override fun pause() {
        player.pause()
    }

    override fun resume() {
        player.play()
    }

    override fun stop() {
        player.stop()
        finish()
    }

    override fun seekTo(positionMs: Long) {
        player.seekTo(positionMs.coerceAtLeast(0L))
    }

    override fun statusJson(): String {
        val state = when {
            player.isPlaying -> "playing"
            player.playbackState == Player.STATE_BUFFERING -> "buffering"
            player.playbackState == Player.STATE_READY -> "paused"
            else -> "idle"
        }
        val duration = if (player.duration > 0) player.duration else 0L
        return Protocol.status(state, player.currentPosition.coerceAtLeast(0L), duration)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                if (player.isPlaying) player.pause() else player.play()
                return true
            }
            KeyEvent.KEYCODE_DPAD_LEFT -> {
                player.seekTo((player.currentPosition - 10_000L).coerceAtLeast(0L))
                return true
            }
            KeyEvent.KEYCODE_DPAD_RIGHT -> {
                player.seekTo(player.currentPosition + 10_000L)
                return true
            }
            KeyEvent.KEYCODE_BACK -> {
                player.stop()
                finish()
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    @Suppress("DEPRECATION")
    private fun hideSystemUi() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            )
    }

    private fun requestAudioFocus() {
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                        .build()
                )
                .setOnAudioFocusChangeListener(audioFocusListener)
                .build()
            audioFocusRequest = request
            audioManager?.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            audioManager?.requestAudioFocus(
                audioFocusListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN
            )
        }
    }

    private fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { audioManager?.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            audioManager?.abandonAudioFocus(audioFocusListener)
        }
    }

    override fun onDestroy() {
        TvWsServer.instance?.attachController(null)
        uiHandler.removeCallbacks(statusTicker)
        player.release()
        abandonAudioFocus()
        super.onDestroy()
    }
}
