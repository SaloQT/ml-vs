import { getActiveAilmentDisplay, truncateAilmentDisplay } from "./ailments.js";
import { GAME } from "./config.js";
import {
  ENEMY_SHEET,
  loadBossImageSet,
  loadBossPortraitImageSet,
  loadEnemyImageSet,
  loadEnemySheet,
  loadSpriteSheet,
  loadUiSheet,
  SPRITE_SHEET,
  UI_SHEET,
} from "./assets.js";
import { clamp } from "./math.js";

export class Renderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.options = {
      screenShake: GAME.screenShake,
      lighting: GAME.lighting,
      particles: GAME.particles,
      ...options,
    };
    this.camera = { x: 0, y: 0, scale: 1 };
    this.sprites = loadSpriteSheet();
    this.enemySprites = loadEnemySheet();
    this.enemyImages = loadEnemyImageSet();
    this.bossImages = loadBossImageSet();
    this.bossPortraitImages = loadBossPortraitImageSet();
    this.uiSprites = loadUiSheet();
    this.stars = createStarfield(420);
    this.particles = [];
    this.damageNumbers = [];
    this.damageSamples = [];
    this.dpsWindow = 5;
    this.peakDps = 50;
    this.particleSeed = 1;
    this.lastElapsed = 0;
    this.seenEffects = new Set();
    this.shake = 0;
    this.cameraInitialized = false;
    this.hudState = {
      hpDisplay: 1,
      xpDisplay: 0,
      shieldDisplay: 0,
      lastHp: null,
      lastXp: 0,
      lastLevel: 1,
      damagePulse: 0,
      xpFlash: 0,
      levelFlash: 0,
      gameOverIn: 0,
    };
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "high";
    this.viewport = { width: rect.width, height: rect.height, dpr };
    this.camera.scale = Math.min(rect.width / GAME.width, rect.height / GAME.height) * GAME.cameraZoom;
  }

  screenToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return {
      x: this.camera.x + (x - this.viewport.width / 2) / this.camera.scale,
      y: this.camera.y + (y - this.viewport.height / 2) / this.camera.scale,
    };
  }

  render(snapshot) {
    const dt = clamp(snapshot.elapsed - this.lastElapsed, 0, 1 / 20);
    this.lastElapsed = snapshot.elapsed;
    const player = snapshot.players.find((item) => item.id === snapshot.localPlayerId) ?? snapshot.players[0];
    if (player) this.updateCamera(player, dt);

    this.ingestEffects(snapshot);
    if (this.options.particles) {
      this.updateParticles(dt, snapshot);
    } else {
      this.particles = [];
    }
    this.updateDamageNumbers(dt);
    this.shake = Math.max(0, this.shake - dt * 9);
    this.clear();
    this.drawWorld(snapshot);
    this.drawHud(snapshot, player);
    if (snapshot.state === "gameover" || snapshot.state === "victory") this.drawGameOver(snapshot);
  }

  clear() {
    const { width, height } = this.viewport;
    const gradient = this.ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#07101c");
    gradient.addColorStop(0.52, "#040712");
    gradient.addColorStop(1, "#100918");
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, width, height);
  }

  drawWorld(snapshot) {
    const ctx = this.ctx;
    const renderCamera = this.pixelAlignedCamera();
    const shakeX = this.options.screenShake && this.shake ? this.randomRange(-this.shake, this.shake) : 0;
    const shakeY = this.options.screenShake && this.shake ? this.randomRange(-this.shake, this.shake) : 0;
    ctx.save();
    ctx.translate(this.viewport.width / 2 + shakeX, this.viewport.height / 2 + shakeY);
    ctx.scale(this.camera.scale, this.camera.scale);
    ctx.translate(-renderCamera.x, -renderCamera.y);

    this.drawStars(renderCamera);
    if (this.options.lighting) this.drawLighting(snapshot);
    if (this.options.particles) this.drawParticles();
    for (const event of snapshot.runEvents?.active ?? []) this.drawRunEvent(event, snapshot.elapsed);
    if (snapshot.bossSpawnTelegraph) this.drawBossSpawnTelegraph(snapshot.bossSpawnTelegraph, snapshot.elapsed);
    for (const effect of snapshot.effects ?? []) this.drawEffect(effect);
    for (const pickup of snapshot.pickups) this.drawPickup(pickup, snapshot.elapsed);
    for (const projectile of snapshot.projectiles) this.drawProjectile(projectile, snapshot.elapsed);
    for (const enemy of snapshot.enemies) this.drawEnemy(enemy, snapshot.elapsed);
    for (const player of snapshot.players) this.drawPlayer(player, snapshot.elapsed);
    this.drawDrones(snapshot);
    this.drawDamageNumbers();

    ctx.restore();
    if (snapshot.bossSpawnTelegraph) this.drawBossSpawnVignette(snapshot.bossSpawnTelegraph, snapshot.elapsed);
  }

  drawRunEvent(event, elapsed) {
    if (event.type === "laneSweep") {
      this.drawLaneSweepEvent(event, elapsed);
    } else if (event.type === "rewardCache") {
      this.drawRewardCacheEvent(event, elapsed);
    }
  }

  drawLaneSweepEvent(event, elapsed) {
    const ctx = this.ctx;
    const warningProgress = clamp((elapsed - event.startedAt) / Math.max(0.001, event.triggerAt - event.startedAt), 0, 1);
    const activeProgress = clamp((elapsed - event.triggerAt) / Math.max(0.001, event.endAt - event.triggerAt), 0, 1);
    const active = elapsed >= event.triggerAt;
    const alpha = active ? 0.46 * (1 - activeProgress) : 0.14 + warningProgress * 0.2;
    const stripeOffset = (elapsed * 180) % 42;
    ctx.save();
    ctx.translate(event.x, event.y);
    ctx.rotate(Math.atan2(event.dirY, event.dirX));
    ctx.fillStyle = active ? `rgba(255, 91, 121, ${alpha})` : `rgba(255, 200, 87, ${alpha})`;
    ctx.fillRect(-event.length / 2, -event.width / 2, event.length, event.width);
    ctx.strokeStyle = active ? "rgba(255, 91, 121, 0.88)" : "rgba(255, 200, 87, 0.78)";
    ctx.lineWidth = active ? 6 : 3;
    ctx.strokeRect(-event.length / 2, -event.width / 2, event.length, event.width);
    ctx.globalAlpha = active ? 0.42 : 0.3 + warningProgress * 0.24;
    ctx.strokeStyle = active ? "#ffd24a" : "#ff5b79";
    ctx.lineWidth = 2;
    for (let x = -event.length / 2 - event.width; x < event.length / 2 + event.width; x += 42) {
      ctx.beginPath();
      ctx.moveTo(x + stripeOffset, -event.width / 2);
      ctx.lineTo(x + stripeOffset + event.width * 0.7, event.width / 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawRewardCacheEvent(event, elapsed) {
    const ctx = this.ctx;
    const warningProgress = clamp((elapsed - event.startedAt) / Math.max(0.001, event.triggerAt - event.startedAt), 0, 1);
    const active = elapsed >= event.triggerAt;
    const collapseProgress = event.collectedAt === null || event.collectedAt === undefined ? 0 : clamp((elapsed - event.collectedAt) / 0.4, 0, 1);
    const pulse = 0.5 + Math.sin(elapsed * 8) * 0.5;
    const radiusBase = active ? event.radius * (0.9 + pulse * 0.08) : event.radius * (0.55 + warningProgress * 0.45);
    const radius = radiusBase * (1 - collapseProgress);
    const alpha = 1 - collapseProgress;
    if (radius <= 0.5 || alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(event.x, event.y);
    ctx.strokeStyle = active ? "rgba(255, 210, 74, 0.9)" : "rgba(100, 217, 255, 0.76)";
    ctx.fillStyle = active ? "rgba(255, 210, 74, 0.12)" : "rgba(100, 217, 255, 0.08)";
    ctx.lineWidth = active ? 4 : 3;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.rotate(elapsed * 0.9);
    ctx.strokeStyle = active ? "rgba(255, 91, 121, 0.72)" : "rgba(255, 210, 74, 0.7)";
    for (let i = 0; i < 4; i += 1) {
      ctx.rotate(Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(radius * 0.72, 0);
      ctx.lineTo(radius * 1.08, 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  updateCamera(player, dt) {
    if (!this.cameraInitialized) {
      this.camera.x = player.x;
      this.camera.y = player.y;
      this.cameraInitialized = true;
      return;
    }

    const scale = Math.max(0.001, this.camera.scale);
    const deadZone = 18 / scale;
    const maxLag = Math.min(this.viewport.width, this.viewport.height) * 0.2 / scale;
    const dx = player.x - this.camera.x;
    const dy = player.y - this.camera.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= deadZone) return;

    const nx = dx / dist;
    const ny = dy / dist;
    const targetX = player.x - nx * deadZone;
    const targetY = player.y - ny * deadZone;
    const follow = 1 - Math.exp(-4.8 * Math.max(0, dt));
    this.camera.x += (targetX - this.camera.x) * follow;
    this.camera.y += (targetY - this.camera.y) * follow;

    const lagX = player.x - this.camera.x;
    const lagY = player.y - this.camera.y;
    const lag = Math.hypot(lagX, lagY);
    if (lag > maxLag) {
      this.camera.x = player.x - (lagX / lag) * maxLag;
      this.camera.y = player.y - (lagY / lag) * maxLag;
    }
  }

  drawStars(camera = this.camera) {
    const ctx = this.ctx;
    for (const star of this.stars) {
      const x = wrap(star.x - camera.x * star.depth, -2200, 2200);
      const y = wrap(star.y - camera.y * star.depth, -1400, 1400);
      ctx.fillStyle = star.color;
      ctx.globalAlpha = star.alpha;
      ctx.beginPath();
      ctx.arc(x + camera.x, y + camera.y, star.radius / this.camera.scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawLighting(snapshot) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const pickup of snapshot.pickups) {
      const style = pickupStyle(pickup.type);
      this.drawGlow(pickup.x, pickup.y, style.glowRadius, style.glow);
    }
    for (const projectile of snapshot.projectiles) {
      this.drawGlow(projectile.x, projectile.y, projectile.splashRadius ? 58 : 46, projectile.glowColor ?? "rgba(100, 225, 255, 0.42)");
    }
    for (const enemy of snapshot.enemies) {
      this.drawGlow(enemy.x, enemy.y, enemyGlowRadius(enemy), enemyGlowColor(enemy));
    }
    for (const player of snapshot.players) {
      this.drawGlow(player.x, player.y, 88, "rgba(78, 214, 255, 0.26)");
    }
    ctx.restore();
  }

  setOptions(options = {}) {
    this.options = {
      ...this.options,
      ...options,
    };
    if (!this.options.particles) this.particles = [];
    if (!this.options.screenShake) this.shake = 0;
  }

  drawPlayer(player, elapsed) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(Math.atan2(player.facingY ?? 0, player.facingX ?? 1));
    const flicker = player.invulnerableFor > 0 ? 0.48 + Math.sin(elapsed * 42) * 0.24 : 1;
    const speed = Math.hypot(player.vx ?? 0, player.vy ?? 0);
    const thrust = clamp(speed / Math.max(player.stats.speed, 1), 0, 1);
    const enginePulse = 0.6 + Math.sin(elapsed * 28) * 0.22 + thrust * 0.28;
    ctx.globalAlpha = flicker;

    this.drawEngineFlame(enginePulse);
    if (this.drawSprite("player", 0, 0, 86, 74)) {
      ctx.restore();
      return;
    }

    ctx.fillStyle = "#64d9ff";
    ctx.beginPath();
    ctx.moveTo(24, 0);
    ctx.lineTo(-16, -14);
    ctx.lineTo(-9, 0);
    ctx.lineTo(-16, 14);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#edf7ff";
    ctx.beginPath();
    ctx.arc(2, 0, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ffc857";
    ctx.globalAlpha = 0.82 * flicker;
    ctx.beginPath();
    ctx.moveTo(-16, -8);
    ctx.lineTo(-34 - Math.sin(elapsed * 18) * 8, 0);
    ctx.lineTo(-16, 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawDrones(snapshot) {
    const ctx = this.ctx;
    for (const player of snapshot.players) {
      for (let i = 0; i < player.stats.drones; i += 1) {
        const angle = snapshot.elapsed * (2.2 + i * 0.22) + (Math.PI * 2 * i) / player.stats.drones;
        const x = player.x + Math.cos(angle) * 78;
        const y = player.y + Math.sin(angle) * 78;
        const pulse = 1 + Math.sin(snapshot.elapsed * 9 + i) * 0.08;
        if (this.drawSprite("orbitalDrone", x, y, 36 * pulse, 38 * pulse, snapshot.elapsed * 4 + i)) continue;
        ctx.fillStyle = "#ff5b79";
        ctx.beginPath();
        ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 91, 121, 0.45)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, 21, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  drawEnemy(enemy, elapsed) {
    const ctx = this.ctx;
    const health = clamp(enemy.hp / enemy.maxHp, 0, 1);
    const spriteName = enemySpriteName(enemy);
    const bob = Math.sin(elapsed * (enemy.type === "bruiser" || enemy.type === "bulwark" ? 3.2 : 5.4) + numericId(enemy.id)) * 2.2;
    const pulse = 1 + Math.sin(elapsed * 4.5 + numericId(enemy.id)) * (enemy.type === "bruiser" || enemy.type === "bulwark" ? 0.025 : 0.05);
    const hitFlash = clamp(enemy.hitFlash / 0.12, 0, 1);
    const hitScale = 1 + hitFlash * 0.16;
    const width = enemyDrawWidth(enemy) * pulse;
    const height = enemyDrawHeight(enemy) * pulse;
    const rotation =
      (enemy.type === "bruiser" || enemy.type === "bulwark" ? Math.sin(elapsed * 1.8 + numericId(enemy.id)) * 0.04 : elapsed * 0.7) +
      hitFlash * 0.1;
    if (!spriteName || !this.drawEnemySprite(spriteName, enemy.x, enemy.y + bob, width * hitScale, height * hitScale, rotation)) {
      ctx.fillStyle = enemyFillColor(enemy);
      ctx.beginPath();
      if (enemy.type === "splitter" || enemy.type === "spitter") {
        ctx.moveTo(enemy.x, enemy.y + bob - enemy.radius);
        ctx.lineTo(enemy.x + enemy.radius, enemy.y + bob + enemy.radius * 0.65);
        ctx.lineTo(enemy.x - enemy.radius, enemy.y + bob + enemy.radius * 0.65);
        ctx.closePath();
      } else if (enemy.type === "stalker") {
        ctx.moveTo(enemy.x, enemy.y + bob - enemy.radius * 0.95);
        ctx.lineTo(enemy.x + enemy.radius * 0.85, enemy.y + bob);
        ctx.lineTo(enemy.x, enemy.y + bob + enemy.radius * 0.95);
        ctx.lineTo(enemy.x - enemy.radius * 0.85, enemy.y + bob);
        ctx.closePath();
      } else if (enemy.type === "bulwark") {
        ctx.rect(enemy.x - enemy.radius * 0.85, enemy.y + bob - enemy.radius * 0.85, enemy.radius * 1.7, enemy.radius * 1.7);
      } else {
        ctx.arc(enemy.x, enemy.y + bob, enemy.radius, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.24)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (enemy.rank === "boss") {
      this.drawBossAura(enemy, bob, elapsed);
      this.drawBossBodyOverlay(enemy, bob, elapsed);
    } else if (enemy.rank === "elite" || enemy.eliteId) this.drawEliteAura(enemy, bob, elapsed);
    if (enemy.affixes?.length || enemy.eliteAffix) this.drawAffixAuras(enemy, bob, elapsed);
    if (hitFlash > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = hitFlash * 0.72;
      ctx.fillStyle = enemy.type === "bruiser" || enemy.type === "bulwark" ? "#f4b7ff" : "#ffffff";
      ctx.beginPath();
      ctx.arc(enemy.x, enemy.y + bob, enemy.radius * (1.25 + hitFlash * 0.35), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = enemy.rank === "boss" ? bossColor(enemy) : enemy.rank === "elite" || enemy.eliteId ? "#ffc857" : "#1df2a4";
    const barWidth = enemy.rank === "boss" ? enemy.radius * 2.7 : enemy.radius * 2;
    const barHeight = enemy.rank === "boss" ? 5 : 3;
    ctx.fillRect(enemy.x - barWidth / 2, enemy.y + bob - enemy.radius - 10, barWidth * health, barHeight);
    this.drawAilmentPips(enemy, bob);
  }

  drawAilmentPips(enemy, bob) {
    const all = getActiveAilmentDisplay(enemy);
    if (!all.length) return;
    const { visible, overflow } = truncateAilmentDisplay(all, 5);
    const ctx = this.ctx;
    const pipW = 7;
    const pipH = 5;
    const gap = 2;
    const pad = 2;
    const overflowW = overflow > 0 ? 12 : 0;
    const pipsWidth = visible.length * pipW + Math.max(0, visible.length - 1) * gap;
    const totalWidth = pipsWidth + (overflow > 0 ? gap + overflowW : 0);
    const startX = Math.round(enemy.x - totalWidth / 2);
    const y = Math.round(enemy.y + bob - enemy.radius - 16);
    ctx.save();
    // Background pill for contrast against busy sprites/HP bar.
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(startX - pad, y - pad, totalWidth + pad * 2, pipH + 2 + pad * 2);
    for (let i = 0; i < visible.length; i += 1) {
      const e = visible[i];
      const x = startX + i * (pipW + gap);
      // Control ailments get a slightly taller, brighter pip with a white
      // outline so freeze/shock/chill read at a glance.
      const tall = e.isControl ? 1 : 0;
      const yy = y - tall;
      const hh = pipH + tall;
      ctx.fillStyle = e.color;
      ctx.fillRect(x, yy, pipW, hh);
      ctx.lineWidth = 1;
      ctx.strokeStyle = e.isControl ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.6)";
      ctx.strokeRect(x + 0.5, yy + 0.5, pipW - 1, hh - 1);
      if (e.showStackCount) {
        ctx.fillStyle = "#0a1410";
        ctx.font = "bold 6px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(e.stacks > 9 ? "9+" : String(e.stacks), x + pipW / 2, yy + hh / 2 + 0.5);
      }
    }
    if (overflow > 0) {
      const x = startX + pipsWidth + gap;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = "bold 8px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(`+${overflow}`, x, y - 1);
    }
    ctx.restore();
  }

  drawEliteAura(enemy, bob, elapsed) {
    const ctx = this.ctx;
    const radius = enemy.radius + 14 + Math.sin(elapsed * 7 + numericId(enemy.id)) * 2;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = "rgba(255, 200, 87, 0.75)";
    ctx.lineWidth = 2.5;
    ctx.setLineDash([12, 7]);
    ctx.lineDashOffset = -elapsed * 32;
    ctx.beginPath();
    ctx.arc(enemy.x, enemy.y + bob, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawBossAura(enemy, bob, elapsed) {
    if (enemy.bossId === "brood-splitter") return this.drawBroodSplitterAura(enemy, bob, elapsed);
    if (enemy.bossId === "siphon-prime") return this.drawSiphonPrimeAura(enemy, bob, elapsed);
    if (enemy.bossId === "bastion-bulwark") return this.drawBastionBulwarkAura(enemy, bob, elapsed);
    if (enemy.bossId === "nova-spitter") return this.drawNovaSpitterAura(enemy, bob, elapsed);
    return this.drawGenericBossAura(enemy, bob, elapsed);
  }

  drawGenericBossAura(enemy, bob, elapsed) {
    const ctx = this.ctx;
    const radius = enemy.radius + 18 + Math.sin(elapsed * 4 + numericId(enemy.id)) * 3;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = bossAuraColor(enemy);
    ctx.lineWidth = 4;
    ctx.setLineDash([18, 8, 4, 8]);
    ctx.lineDashOffset = -elapsed * 24;
    ctx.beginPath();
    ctx.arc(enemy.x, enemy.y + bob, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = bossAuraColor(enemy);
    ctx.beginPath();
    ctx.arc(enemy.x, enemy.y + bob, radius * 0.92, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawBroodSplitterAura(enemy, bob, elapsed) {
    const ctx = this.ctx;
    const radius = enemy.radius + 20;
    const health = clamp(enemy.hp / Math.max(1, enemy.maxHp), 0, 1);
    const visibleSegments = Math.max(1, Math.ceil(health * 6));
    const telegraph = bossTelegraphProgress(enemy, "split", elapsed, 0.8);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = "rgba(255, 154, 61, 0.84)";
    ctx.lineWidth = 4;
    ctx.translate(enemy.x, enemy.y + bob);
    ctx.rotate(elapsed * 0.6);
    for (let i = 0; i < visibleSegments; i += 1) {
      const start = (Math.PI * 2 * i) / 6;
      ctx.globalAlpha = 0.55 + i * 0.055;
      ctx.beginPath();
      ctx.arc(0, 0, radius, start, start + Math.PI / 5);
      ctx.stroke();
    }
    if (telegraph > 0.72) {
      ctx.globalAlpha = (telegraph - 0.72) / 0.28;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(0, 0, enemy.radius * 0.92, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawSiphonPrimeAura(enemy, bob, elapsed) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(enemy.x, enemy.y + bob);
    ctx.strokeStyle = "rgba(37, 214, 255, 0.78)";
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    ctx.lineDashOffset = -elapsed * 38;
    ctx.beginPath();
    ctx.arc(0, 0, enemy.radius + 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 9]);
    ctx.lineDashOffset = elapsed * 58;
    ctx.beginPath();
    ctx.arc(0, 0, enemy.radius + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    if ((enemy.siphonFor ?? 0) > 0 && Number.isFinite(enemy.siphonTargetX) && Number.isFinite(enemy.siphonTargetY)) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = "rgba(37, 214, 255, 0.55)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([10, 6]);
      ctx.lineDashOffset = -elapsed * 60;
      ctx.beginPath();
      ctx.moveTo(enemy.x, enemy.y + bob);
      ctx.lineTo(enemy.siphonTargetX, enemy.siphonTargetY);
      ctx.stroke();
      for (let i = 0; i < 5; i += 1) {
        const t = (elapsed * 1.6 + i / 5) % 1;
        const x = enemy.siphonTargetX + (enemy.x - enemy.siphonTargetX) * t;
        const y = enemy.siphonTargetY + (enemy.y + bob - enemy.siphonTargetY) * t;
        ctx.globalAlpha = 0.9 * (1 - t);
        ctx.fillStyle = "#25d6ff";
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawBastionBulwarkAura(enemy, bob, elapsed) {
    const ctx = this.ctx;
    const flash = clamp((enemy.armoredFlashFor ?? 0) / 0.25, 0, 1);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(enemy.x, enemy.y + bob);
    ctx.rotate(elapsed * 0.2);
    ctx.strokeStyle = flash > 0 ? `rgba(255, 255, 255, ${0.22 + flash * 0.68})` : "rgba(124, 136, 255, 0.78)";
    ctx.lineWidth = 3;
    ctx.setLineDash([2, 4]);
    polygonPath(ctx, 0, 0, enemy.radius + 22, 6, -Math.PI / 6);
    ctx.stroke();
    const slam = bossTelegraphProgress(enemy, "slam", elapsed, 1);
    if (slam > 0.65) {
      const ringProgress = (slam - 0.65) / 0.35;
      ctx.setLineDash([]);
      ctx.strokeStyle = `rgba(124, 136, 255, ${0.75 * (1 - ringProgress)})`;
      ctx.lineWidth = 6 * (1 - ringProgress);
      ctx.beginPath();
      ctx.arc(0, 0, enemy.radius + 60 * ringProgress, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawNovaSpitterAura(enemy, bob, elapsed) {
    const ctx = this.ctx;
    const radius = enemy.radius + 12;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = "rgba(215, 255, 87, 0.76)";
    ctx.lineWidth = 2;
    ctx.translate(enemy.x, enemy.y + bob);
    for (let i = 0; i < 12; i += 1) {
      const jitter = seededNoise(numericId(enemy.id), i, Math.floor(elapsed * 30));
      ctx.globalAlpha = 0.4 + jitter * 0.6;
      const angle = (Math.PI * 2 * i) / 12 + Math.sin(elapsed * 4 + i) * 0.04;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
      ctx.lineTo(Math.cos(angle) * (radius + 10), Math.sin(angle) * (radius + 10));
      ctx.stroke();
    }
    const burst = bossTelegraphProgress(enemy, "burst", elapsed, 1);
    if (burst > 0) {
      const gradient = ctx.createRadialGradient(0, 0, enemy.radius * 0.4, 0, 0, enemy.radius + 90);
      gradient.addColorStop(0, `rgba(255, 247, 192, ${0.45 * burst})`);
      gradient.addColorStop(1, "rgba(215, 255, 87, 0)");
      ctx.globalAlpha = 1;
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(0, 0, enemy.radius + 90, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawBossBodyOverlay(enemy, bob, elapsed) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(enemy.x, enemy.y + bob);
    if (enemy.bossId === "brood-splitter") {
      const telegraph = bossTelegraphProgress(enemy, "split", elapsed, 0.8);
      const orbitRadius = enemy.radius + 20 + telegraph * 30;
      const squash = telegraph > 0 ? 1 - Math.sin(telegraph * Math.PI) * 0.22 + Math.max(0, telegraph - 0.65) * 0.8 : 1;
      ctx.scale(1.08 / Math.max(0.4, squash), squash);
      ctx.fillStyle = "rgba(255, 154, 61, 0.88)";
      for (let i = 0; i < 3; i += 1) {
        const angle = elapsed * Math.PI * 2 * 1.4 + (Math.PI * 2 * i) / 3;
        drawShardGlyph(ctx, Math.cos(angle) * orbitRadius, Math.sin(angle) * orbitRadius, 5 + telegraph * 2, angle);
      }
    } else if (enemy.bossId === "siphon-prime") {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
      ctx.beginPath();
      ctx.arc(0, 0, enemy.radius * 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(37, 214, 255, 0.72)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, enemy.radius * 0.55, 0, Math.PI * 2);
      ctx.stroke();
    } else if (enemy.bossId === "bastion-bulwark") {
      const slam = bossTelegraphProgress(enemy, "slam", elapsed, 1);
      const plateOffset = slam * 12;
      ctx.fillStyle = "rgba(124, 136, 255, 0.55)";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.34)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 4; i += 1) {
        ctx.save();
        ctx.rotate((Math.PI / 2) * i + Math.sin(elapsed * 1.8 + numericId(enemy.id)) * 0.04);
        ctx.beginPath();
        ctx.moveTo(enemy.radius * 0.35, -enemy.radius * 0.24);
        ctx.lineTo(enemy.radius + plateOffset, -enemy.radius * 0.36);
        ctx.lineTo(enemy.radius + plateOffset, enemy.radius * 0.36);
        ctx.lineTo(enemy.radius * 0.35, enemy.radius * 0.24);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    } else if (enemy.bossId === "nova-spitter") {
      const burst = bossTelegraphProgress(enemy, "burst", elapsed, 1);
      const orbitRadius = enemy.radius * (0.7 - burst * 0.45);
      for (let i = 0; i < 3; i += 1) {
        const angle = elapsed * Math.PI * 2 * (3 + burst * 3) + (Math.PI * 2 * i) / 3;
        const x = Math.cos(angle) * orbitRadius;
        const y = Math.sin(angle) * orbitRadius;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, 8);
        gradient.addColorStop(0, "#fff7c0");
        gradient.addColorStop(1, "rgba(215, 255, 87, 0)");
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  drawBossSpawnTelegraph(telegraph, elapsed) {
    const ctx = this.ctx;
    const progress = clamp((elapsed - telegraph.startedAt) / Math.max(0.001, telegraph.duration), 0, 1);
    const ease = progress * progress * (3 - progress * 2);
    const radius = 10 + ease * 80;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(telegraph.x, telegraph.y);
    ctx.strokeStyle = hexToRgba(telegraph.color, 0.85 * (1 - progress * 0.35));
    ctx.lineWidth = 3 - progress * 2;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    for (let i = 0; i < 6; i += 1) {
      const angle = (Math.PI * 2 * i) / 6 + elapsed * 0.18;
      const r = 160 - ease * 140;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle + Math.PI);
      ctx.strokeStyle = hexToRgba(telegraph.color, 0.78);
      ctx.beginPath();
      ctx.moveTo(-10, -8);
      ctx.lineTo(0, 0);
      ctx.lineTo(-10, 8);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  drawBossSpawnVignette(telegraph, elapsed) {
    const timeLeft = telegraph.triggerAt - elapsed;
    if (timeLeft > 0.4) return;
    const progress = clamp(1 - timeLeft / 0.4, 0, 1);
    const ctx = this.ctx;
    const { width, height } = this.viewport;
    const gradient = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.32, width / 2, height / 2, Math.max(width, height) * 0.72);
    gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
    gradient.addColorStop(1, hexToRgba(telegraph.color, 0.18 * Math.sin(progress * Math.PI)));
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  drawAffixAuras(enemy, bob, elapsed) {
    const ctx = this.ctx;
    const affixes = enemy.affixes?.length ? enemy.affixes : [enemy.eliteAffix];
    for (let i = 0; i < affixes.length; i += 1) {
      const style = affixAuraStyle(affixes[i]);
      const volatileWarning = affixes[i] === "volatile" && (enemy.hp / Math.max(1, enemy.maxHp) <= 0.18 || (enemy.volatileBurstIn ?? Infinity) <= 0.6);
      const pulse = volatileWarning ? 22 : style.pulse;
      const radius = enemy.radius + 8 + i * 7 + Math.sin(elapsed * pulse + i) * 1.5;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = i === 0 ? 3 : 2;
      ctx.setLineDash(style.dash);
      ctx.lineDashOffset = -elapsed * style.spin * style.dashDirection;
      ctx.beginPath();
      ctx.arc(enemy.x, enemy.y + bob, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = style.dot;
      for (let dot = 0; dot < style.dots; dot += 1) {
        const angle = elapsed * style.spin * 0.08 * style.dashDirection + (Math.PI * 2 * dot) / style.dots;
        ctx.beginPath();
        ctx.arc(enemy.x + Math.cos(angle) * radius, enemy.y + bob + Math.sin(angle) * radius, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      if (volatileWarning) {
        ctx.globalAlpha = Math.max(0, Math.sin(elapsed * Math.PI * 22));
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(enemy.x, enemy.y + bob, enemy.radius * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawEliteRing(enemy, bob, elapsed) {
    this.drawAffixAuras(enemy, bob, elapsed);
  }

  drawProjectile(projectile, elapsed) {
    const ctx = this.ctx;
    const angle = Math.atan2(projectile.vy, projectile.vx);
    const pulse = 1 + Math.sin(elapsed * 24 + projectile.x * 0.02) * 0.1;
    ctx.save();
    ctx.globalAlpha = 0.32;
    this.drawSprite("plasmaBolt", projectile.x, projectile.y, 52 * pulse, 26 * pulse, angle);
    ctx.restore();
    if (this.drawSprite("plasmaBolt", projectile.x, projectile.y, 38 * pulse, 19 * pulse, angle)) return;
    ctx.strokeStyle = projectile.color ?? "#8ff3ff";
    ctx.lineWidth = projectile.splashRadius ? 8 : 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(projectile.x, projectile.y);
    ctx.lineTo(projectile.x - projectile.vx * 0.025, projectile.y - projectile.vy * 0.025);
    ctx.stroke();
  }

  drawPickup(pickup, elapsed) {
    const ctx = this.ctx;
    const style = pickupStyle(pickup.type);
    const bob = Math.sin(elapsed * 5 + pickup.x * 0.03) * 4;
    const pulse = 1 + Math.sin(elapsed * 7 + pickup.y * 0.02) * 0.07;
    const rotation = style.sprite === "shieldPickup" ? Math.sin(elapsed * 2.5) * 0.08 : elapsed * style.spin;
    if (this.drawSprite(style.sprite, pickup.x, pickup.y + bob, style.size * pulse, style.size * pulse, rotation)) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = style.fill;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pickup.x, pickup.y + bob, pickup.radius + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.fillStyle = style.fill;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (style.shape === "circle") {
      ctx.arc(pickup.x, pickup.y + bob, pickup.radius, 0, Math.PI * 2);
    } else {
      ctx.rect(pickup.x - pickup.radius, pickup.y + bob - pickup.radius, pickup.radius * 2, pickup.radius * 2);
    }
    ctx.fill();
    ctx.stroke();
  }

  drawEffect(effect) {
    if (effect.type === "projectileImpact") {
      this.drawImpactEffect(effect);
      return;
    }
    if (effect.type === "enemyDestroyed") {
      this.drawExplosionEffect(effect);
      return;
    }
    if (
      effect.type !== "gravityWell" &&
      effect.type !== "overdrive" &&
      effect.type !== "magnetBurst" &&
      effect.type !== "cacheOpened" &&
      effect.type !== "volatileBurst" &&
      effect.type !== "bossSpawnBurst"
    ) {
      return;
    }
    const progress = 1 - effect.ttl / effect.duration;
    const alpha = 1 - progress;
    const size = effect.radius * (0.55 + progress * 0.7);
    this.ctx.save();
    this.ctx.globalAlpha = alpha * 0.78;
    if (effect.type === "gravityWell") {
      this.drawSprite("gravityWell", effect.x, effect.y, size, size);
    } else if (effect.type === "volatileBurst") {
      this.drawGlow(effect.x, effect.y, size, "rgba(255, 91, 121, 0.44)");
      this.ctx.strokeStyle = `rgba(255, 200, 87, ${0.82 * (1 - progress)})`;
      this.ctx.lineWidth = 3;
      this.ctx.beginPath();
      this.ctx.arc(effect.x, effect.y, size * 0.5, 0, Math.PI * 2);
      this.ctx.stroke();
    } else if (effect.type === "bossSpawnBurst") {
      this.drawGlow(effect.x, effect.y, size, "rgba(255, 255, 255, 0.36)");
      this.ctx.strokeStyle = `rgba(255, 255, 255, ${0.7 * (1 - progress)})`;
      this.ctx.lineWidth = 5 * (1 - progress);
      this.ctx.beginPath();
      this.ctx.arc(effect.x, effect.y, size * 0.5, 0, Math.PI * 2);
      this.ctx.stroke();
    } else {
      const style = collectionEffectStyle(effect.type);
      this.drawGlow(effect.x, effect.y, size, style.glow);
      this.ctx.strokeStyle = style.stroke;
      this.ctx.lineWidth = 4 * alpha;
      this.ctx.beginPath();
      this.ctx.arc(effect.x, effect.y, size * 0.42, 0, Math.PI * 2);
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  drawImpactEffect(effect) {
    const progress = 1 - effect.ttl / effect.duration;
    const alpha = 1 - progress;
    const radius = effect.radius * (0.35 + progress * 0.9);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = `rgba(143, 243, 255, ${alpha * 0.82})`;
    ctx.lineWidth = 3 * alpha;
    ctx.beginPath();
    ctx.arc(effect.x, effect.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    this.drawGlow(effect.x, effect.y, radius * 1.5, `rgba(143, 243, 255, ${alpha * 0.42})`);
    ctx.restore();
  }

  drawExplosionEffect(effect) {
    const progress = 1 - effect.ttl / effect.duration;
    const alpha = 1 - progress;
    const radius = effect.radius * (0.28 + progress);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    this.drawGlow(effect.x, effect.y, radius * 1.6, `rgba(255, 91, 121, ${alpha * 0.34})`);
    this.drawGlow(effect.x, effect.y, radius, `rgba(255, 200, 87, ${alpha * 0.28})`);
    ctx.strokeStyle = `rgba(255, 225, 170, ${alpha * 0.8})`;
    ctx.lineWidth = 5 * alpha;
    ctx.beginPath();
    ctx.arc(effect.x, effect.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawEngineFlame(pulse) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = clamp(pulse, 0.35, 1);
    const length = 22 + pulse * 16;
    const width = 9 + pulse * 5;
    const gradient = ctx.createLinearGradient(-34 - length, 0, -28, 0);
    gradient.addColorStop(0, "rgba(24, 126, 255, 0)");
    gradient.addColorStop(0.55, "rgba(70, 220, 255, 0.78)");
    gradient.addColorStop(1, "rgba(255, 246, 184, 0.9)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(-30, -width);
    ctx.lineTo(-34 - length, 0);
    ctx.lineTo(-30, width);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  updateParticles(dt, snapshot) {
    if (dt <= 0) return;
    for (const player of snapshot.players) {
      const speed = Math.hypot(player.vx ?? 0, player.vy ?? 0);
      const thrust = clamp(speed / Math.max(player.stats.speed, 1), 0, 1);
      if (thrust > 0.08) {
        const facing = normalizeVector(player.facingX ?? 1, player.facingY ?? 0);
        const exhaustX = player.x - facing.x * 38;
        const exhaustY = player.y - facing.y * 38;
        this.emitParticleBurst(exhaustX, exhaustY, 38 * dt + thrust * 42 * dt, {
          baseVx: -facing.x * 120,
          baseVy: -facing.y * 120,
          spread: 95,
          size: 3.2,
          ttl: 0.42,
          color: "rgba(83, 218, 255, 0.78)",
        });
      }
    }

    for (const projectile of snapshot.projectiles) {
      const dir = normalizeVector(projectile.vx, projectile.vy);
      this.emitParticleBurst(projectile.x - dir.x * 10, projectile.y - dir.y * 10, 70 * dt, {
        baseVx: -dir.x * 80,
        baseVy: -dir.y * 80,
        spread: 45,
        size: 2.3,
        ttl: 0.28,
        color: "rgba(143, 243, 255, 0.74)",
      });
    }

    for (const pickup of snapshot.pickups) {
      const style = pickupStyle(pickup.type);
      this.emitParticleBurst(pickup.x, pickup.y, 8 * dt, {
        baseVx: 0,
        baseVy: -18,
        spread: 32,
        size: style.particleSize,
        ttl: 0.8,
        color: style.particle,
      });
    }
    this.emitSpaceDust(dt);

    for (const particle of this.particles) {
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vx *= Math.pow(particle.drag, dt * 60);
      particle.vy *= Math.pow(particle.drag, dt * 60);
      particle.ttl -= dt;
    }
    this.particles = this.particles.filter((particle) => particle.ttl > 0).slice(-650);
  }

  ingestEffects(snapshot) {
    const activeIds = new Set();
    for (const effect of snapshot.effects ?? []) {
      activeIds.add(effect.id);
      if (this.seenEffects.has(effect.id)) continue;
      this.seenEffects.add(effect.id);
      if (effect.type === "projectileImpact") {
        this.addDamageFeedback(effect, snapshot.elapsed, false);
        if (this.options.screenShake) this.shake = Math.max(this.shake, 2.2);
        if (this.options.particles) {
          this.emitImpactParticles(effect, 18, "rgba(143, 243, 255, 0.86)", "rgba(255, 255, 255, 0.78)");
        }
      } else if (effect.type === "enemyDestroyed") {
        this.addDamageFeedback(effect, snapshot.elapsed, true);
        if (this.options.screenShake) this.shake = Math.max(this.shake, 6.5);
        if (this.options.particles) {
          this.emitImpactParticles(effect, 46, "rgba(255, 91, 121, 0.9)", "rgba(255, 200, 87, 0.88)");
        }
      } else if (effect.type === "bossSpawnBurst") {
        if (this.options.screenShake) this.shake = Math.max(this.shake, 5);
        if (this.options.particles) {
          this.emitRadialParticles(effect, 60, "rgba(255, 255, 255, 0.85)", "rgba(255, 200, 87, 0.82)");
        }
      }
    }
    for (const id of this.seenEffects) {
      if (!activeIds.has(id)) this.seenEffects.delete(id);
    }
  }

  addDamageFeedback(effect, elapsed, destroyed) {
    const damage = Number(effect.damage);
    if (!Number.isFinite(damage) || damage <= 0) return;
    const dir = normalizeVector(effect.directionX ?? 1, effect.directionY ?? 0);
    const tangent = { x: -dir.y, y: dir.x };
    const jitter = this.randomRange(-10, 10);
    const size = destroyed ? 26 : damage >= 50 ? 22 : 18;
    const ttl = destroyed ? 0.96 : 0.72;
    this.damageNumbers.push({
      x: effect.x + tangent.x * jitter,
      y: effect.y - 10 + tangent.y * jitter,
      vx: tangent.x * this.randomRange(-18, 18) - dir.x * 12,
      vy: -54 - this.randomRange(0, 22),
      damage,
      ttl,
      life: ttl,
      destroyed,
      size,
    });
    this.damageNumbers = this.damageNumbers.slice(-120);
    this.damageSamples.push({ time: elapsed, damage });
    this.pruneDamageSamples(elapsed);
  }

  updateDamageNumbers(dt) {
    if (dt <= 0) return;
    for (const number of this.damageNumbers) {
      number.x += number.vx * dt;
      number.y += number.vy * dt;
      number.vx *= Math.pow(0.88, dt * 60);
      number.vy += 28 * dt;
      number.ttl -= dt;
    }
    this.damageNumbers = this.damageNumbers.filter((number) => number.ttl > 0);
  }

  drawDamageNumbers() {
    if (!this.damageNumbers.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const number of this.damageNumbers) {
      const progress = 1 - number.ttl / number.life;
      const alpha = clamp(number.ttl / number.life, 0, 1);
      const pop = 1 + Math.max(0, 0.22 - progress) * 0.9;
      const label = formatDamage(number.damage);
      ctx.globalAlpha = alpha;
      ctx.font = `900 ${number.size * pop}px Inter, system-ui, sans-serif`;
      ctx.lineWidth = number.destroyed ? 5 : 4;
      ctx.strokeStyle = "rgba(2, 5, 12, 0.86)";
      ctx.strokeText(label, number.x, number.y);
      ctx.fillStyle = number.destroyed ? "#ffc857" : number.damage >= 50 ? "#ff7f9b" : "#d7fbff";
      ctx.fillText(label, number.x, number.y);
    }
    ctx.restore();
  }

  pruneDamageSamples(elapsed) {
    const oldest = elapsed - this.dpsWindow;
    this.damageSamples = this.damageSamples.filter((sample) => sample.time >= oldest);
  }

  currentDps(elapsed) {
    this.pruneDamageSamples(elapsed);
    const damage = this.damageSamples.reduce((total, sample) => total + sample.damage, 0);
    return damage / this.dpsWindow;
  }

  emitImpactParticles(effect, count, primaryColor, secondaryColor) {
    const dir = normalizeVector(effect.directionX ?? 1, effect.directionY ?? 0);
    const tangent = { x: -dir.y, y: dir.x };
    for (let i = 0; i < count; i += 1) {
      const spread = this.randomRange(-1, 1);
      const speed = this.randomRange(effect.type === "enemyDestroyed" ? 90 : 45, effect.type === "enemyDestroyed" ? 260 : 180);
      const outward = this.randomRange(0.4, 1.1);
      const vx = dir.x * speed * outward + tangent.x * spread * speed * 0.7;
      const vy = dir.y * speed * outward + tangent.y * spread * speed * 0.7;
      const ttl = this.randomRange(0.22, effect.type === "enemyDestroyed" ? 0.72 : 0.42);
      this.particles.push({
        x: effect.x + this.randomRange(-5, 5),
        y: effect.y + this.randomRange(-5, 5),
        vx,
        vy,
        size: this.randomRange(2.2, effect.type === "enemyDestroyed" ? 5.8 : 4.2),
        color: this.random() < 0.72 ? primaryColor : secondaryColor,
        ttl,
        life: ttl,
        drag: 0.9,
        alpha: this.randomRange(0.72, 1),
      });
    }
  }

  emitRadialParticles(effect, count, primaryColor, secondaryColor) {
    for (let i = 0; i < count; i += 1) {
      const angle = (Math.PI * 2 * i) / count + this.randomRange(-0.08, 0.08);
      const speed = this.randomRange(110, 320);
      const ttl = this.randomRange(0.32, 0.84);
      this.particles.push({
        x: effect.x + Math.cos(angle) * this.randomRange(2, 12),
        y: effect.y + Math.sin(angle) * this.randomRange(2, 12),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: this.randomRange(2.4, 5.4),
        color: this.random() < 0.62 ? primaryColor : secondaryColor,
        ttl,
        life: ttl,
        drag: 0.9,
        alpha: this.randomRange(0.72, 1),
      });
    }
  }

  emitParticleBurst(x, y, amount, options) {
    let whole = Math.floor(amount);
    if (this.random() < amount - whole) whole += 1;
    for (let i = 0; i < whole; i += 1) {
      const angle = this.random() * Math.PI * 2;
      const speed = this.randomRange(0.25, 1) * options.spread;
      const ttl = options.ttl * this.randomRange(0.72, 1.2);
      this.particles.push({
        x: x + this.randomRange(-3, 3),
        y: y + this.randomRange(-3, 3),
        vx: options.baseVx + Math.cos(angle) * speed,
        vy: options.baseVy + Math.sin(angle) * speed,
        size: options.size * this.randomRange(0.65, 1.35),
        color: options.color,
        ttl,
        life: ttl,
        drag: 0.91,
      });
    }
  }

  drawParticles() {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const particle of this.particles) {
      const alpha = clamp(particle.ttl / particle.life, 0, 1);
      ctx.globalAlpha = alpha * (particle.alpha ?? 1);
      ctx.fillStyle = particle.color;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.size * (0.55 + alpha * 0.45), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  emitSpaceDust(dt) {
    const amount = 18 * dt;
    let count = Math.floor(amount);
    if (this.random() < amount - count) count += 1;
    const halfWidth = this.viewport.width / this.camera.scale / 2;
    const halfHeight = this.viewport.height / this.camera.scale / 2;
    for (let i = 0; i < count; i += 1) {
      this.particles.push({
        x: this.camera.x + this.randomRange(-halfWidth, halfWidth),
        y: this.camera.y + this.randomRange(-halfHeight, halfHeight),
        vx: this.randomRange(-6, 6),
        vy: this.randomRange(10, 28),
        size: this.randomRange(0.7, 1.8),
        color: this.random() < 0.35 ? "rgba(100, 217, 255, 0.36)" : "rgba(255, 255, 255, 0.28)",
        ttl: this.randomRange(1.2, 2.2),
        life: 2.2,
        drag: 1,
        alpha: this.randomRange(0.35, 0.75),
      });
    }
  }

  drawHud(snapshot, player) {
    if (!player) return;
    const ctx = this.ctx;
    const dt = clamp(snapshot.elapsed - (this.hudState.lastFrameElapsed ?? snapshot.elapsed), 0, 1 / 12);
    this.hudState.lastFrameElapsed = snapshot.elapsed;

    const maxHp = Math.max(1, player.stats.maxHp);
    const hpAmount = clamp(player.hp / maxHp, 0, 1);
    const shieldAmount = clamp((player.shield ?? 0) / maxHp, 0, 1);
    const xpAmount = clamp(player.xp / Math.max(1, player.nextLevelXp), 0, 1);

    // Animation state
    const hs = this.hudState;
    if (hs.lastHp === null) hs.lastHp = player.hp;
    if (player.hp < hs.lastHp - 0.5) hs.damagePulse = 1;
    if (player.level > hs.lastLevel) {
      hs.levelFlash = 1;
      hs.xpFlash = 1;
    } else if (player.xp > hs.lastXp + 0.01) {
      hs.xpFlash = Math.max(hs.xpFlash, 0.6);
    }
    hs.lastHp = player.hp;
    hs.lastXp = player.xp;
    hs.lastLevel = player.level;

    const ease = 1 - Math.pow(0.0009, Math.max(dt, 0.001));
    hs.hpDisplay += (hpAmount - hs.hpDisplay) * ease;
    hs.shieldDisplay += (shieldAmount - hs.shieldDisplay) * ease;
    hs.xpDisplay += (xpAmount - hs.xpDisplay) * ease;
    hs.damagePulse = Math.max(0, hs.damagePulse - dt * 2.4);
    hs.xpFlash = Math.max(0, hs.xpFlash - dt * 1.6);
    hs.levelFlash = Math.max(0, hs.levelFlash - dt * 1.1);

    const dps = this.currentDps(snapshot.elapsed);
    this.peakDps = Math.max(this.peakDps * 0.998, dps, 50);

    const vw = this.viewport.width;
    const vh = this.viewport.height;
    const pad = vw < 520 ? 10 : 18;
    const t = snapshot.elapsed;

    ctx.save();

    // === HP BLOCK (top-left, edge-anchored, no panel) ===
    const hpW = Math.max(220, Math.min(460, vw * 0.34));
    const hpH = 22;
    const hpX = pad;
    const hpY = pad + 18; // leave room for label above
    this.drawUiIcon("hull", hpX + 18, hpY + hpH / 2 + 2, 38, 38);
    const hpColor = hpHealthColor(hs.hpDisplay);
    const damageWobble = hs.damagePulse > 0 ? Math.sin(t * 50) * hs.damagePulse * 1.6 : 0;
    const hpBarX = hpX + 44;
    const hpBarW = hpW - 44;
    ctx.save();
    ctx.translate(damageWobble, 0);
    this.drawStatBar(hpBarX, hpY, hpBarW, hpH, hs.hpDisplay, hpColor, {
      label: "HULL INTEGRITY",
      value: `${Math.ceil(player.hp)} / ${Math.round(maxHp)}`,
      glow: 0.6 + hs.damagePulse * 0.5,
      pulse: hs.damagePulse,
      shield: hs.shieldDisplay,
      shieldColor: "#7df3ff",
      ticks: 5,
      time: t,
    });
    ctx.restore();

    // DPS readout below HP (compact, no panel)
    const dpsY = hpY + hpH + 18;
    ctx.font = "800 10px Inter, system-ui, sans-serif";
    ctx.fillStyle = "rgba(237, 247, 255, 0.7)";
    ctx.textAlign = "left";
    ctx.fillText("DPS", hpBarX, dpsY);
    ctx.fillStyle = "#ffc857";
    ctx.textAlign = "right";
    ctx.fillText(formatDamage(dps), hpBarX + hpBarW, dpsY);
    ctx.textAlign = "left";
    drawBar(ctx, hpBarX, dpsY + 4, hpBarW, 3, dps / this.peakDps, "#ff5b79");

    // === STAT TILES — spread along top edge, center-anchored ===
    if (vw >= 720) {
      const tileH = 64;
      const tileW = Math.min(120, (vw - hpW - 320 - pad * 4) / 3);
      if (tileW >= 80) {
        const tileGap = 8;
        const totalW = tileW * 3 + tileGap * 2;
        const tileStart = (vw - totalW) / 2;
        const tileY = pad;
        this.drawStatTile(tileStart, tileY, tileW, tileH, "wave", "WAVE", String(snapshot.wave), "#b86cff");
        this.drawStatTile(tileStart + tileW + tileGap, tileY, tileW, tileH, "timer", "TIME", formatTime(snapshot.elapsed), "#64d9ff");
        this.drawStatTile(tileStart + (tileW + tileGap) * 2, tileY, tileW, tileH, null, "KILLS", String(player.kills ?? 0), "#ff5b79");
      }
    } else {
      // narrow viewport — stats below HP
      const tileY = dpsY + 14;
      const tileH = 52;
      const tileW = (hpW - 12) / 3;
      this.drawStatTile(hpX, tileY, tileW, tileH, "wave", "WAVE", String(snapshot.wave), "#b86cff");
      this.drawStatTile(hpX + (tileW + 6), tileY, tileW, tileH, "timer", "TIME", formatTime(snapshot.elapsed), "#64d9ff");
      this.drawStatTile(hpX + (tileW + 6) * 2, tileY, tileW, tileH, null, "KILLS", String(player.kills ?? 0), "#ff5b79");
    }

    // === TARGETING / THREAT (top-right) ===
    if (vw >= 760) {
      const target = snapshot.targeting?.primaryWeapon;
      const tw = 304;
      const th = 86;
      const tx = vw - tw - pad;
      const ty = pad;
      this.drawNeonPanel(tx, ty, tw, th, "#ff5b79", 0.5);
      // Pulsing accent left edge
      const pulse = 0.6 + 0.4 * Math.sin(t * 3.4);
      ctx.save();
      ctx.fillStyle = `rgba(255, 91, 121, ${0.5 + pulse * 0.4})`;
      ctx.fillRect(tx + 6, ty + 12, 3, th - 24);
      ctx.shadowColor = "rgba(255, 91, 121, 0.85)";
      ctx.shadowBlur = 10;
      ctx.fillRect(tx + 6, ty + 12, 3, th - 24);
      ctx.restore();

      this.drawUiIcon("target", tx + 38, ty + 30, 36, 36);
      const aimAssist = snapshot.aimAssist ?? null;
      const assistOn = Boolean(aimAssist?.enabled);
      const accent = assistOn ? "#64d9ff" : "#ffeef1";
      const labelColor = assistOn ? "rgba(170, 226, 255, 0.78)" : "rgba(255, 178, 192, 0.7)";
      ctx.font = "900 9px Inter, system-ui, sans-serif";
      ctx.fillStyle = labelColor;
      ctx.textAlign = "left";
      ctx.fillText("WEAPON AIM", tx + 64, ty + 18);
      ctx.font = "900 16px Inter, system-ui, sans-serif";
      ctx.fillStyle = accent;
      const aimText = assistOn
        ? `AUTO • ${aimAssist.modeLabel ?? "NEAREST"}`
        : target ? "MANUAL VECTOR" : "MANUAL AIM";
      ctx.fillText(aimText, tx + 64, ty + 38);
      if (aimAssist) {
        ctx.font = "700 8px Inter, system-ui, sans-serif";
        ctx.fillStyle = "rgba(170, 226, 255, 0.55)";
        ctx.fillText("T TOGGLE • Y CYCLE", tx + 64, ty + 76);
      }

      const contacts = snapshot.enemies.length;
      ctx.font = "700 10px Inter, system-ui, sans-serif";
      ctx.fillStyle = "rgba(255, 178, 192, 0.85)";
      ctx.fillText("THREAT", tx + 14, ty + 62);
      // Threat dots — 8 dots, larger
      const dotsX = tx + 64;
      const dotY = ty + 60;
      const threatLevel = clamp(Math.floor(contacts / 6), 0, 8);
      for (let i = 0; i < 8; i += 1) {
        const lit = i < threatLevel;
        ctx.fillStyle = lit
          ? `rgba(255, 91, 121, ${0.7 + Math.sin(t * 4 + i) * 0.25})`
          : "rgba(255, 91, 121, 0.16)";
        ctx.beginPath();
        ctx.arc(dotsX + i * 14, dotY, 4, 0, Math.PI * 2);
        ctx.fill();
        if (lit) {
          ctx.save();
          ctx.shadowColor = "#ff5b79";
          ctx.shadowBlur = 8;
          ctx.fill();
          ctx.restore();
        }
      }
      ctx.font = "900 18px Inter, system-ui, sans-serif";
      ctx.fillStyle = "#ffeef1";
      ctx.textAlign = "right";
      ctx.shadowColor = "rgba(255, 91, 121, 0.7)";
      ctx.shadowBlur = 6;
      ctx.fillText(`${contacts}`, tx + tw - 14, ty + 42);
      ctx.shadowBlur = 0;
      ctx.font = "700 9px Inter, system-ui, sans-serif";
      ctx.fillStyle = "rgba(255, 178, 192, 0.7)";
      ctx.fillText("CONTACTS", tx + tw - 14, ty + 56);
      ctx.textAlign = "left";
    }

    this.drawBossHud(snapshot, pad, t);
    this.drawRunEventAlert(snapshot);

    // === XP BAR — full-width hero element, bottom edge ===
    const xpH = 22;
    const xpMargin = 0; // bleed to edge
    const xpY = vh - xpH - xpMargin - 4;
    const xpX = 0;
    const xpW = vw;

    // Backdrop strip behind bar — pure flat with subtle gradient & top hairline
    ctx.save();
    const bdH = xpH + 28;
    const bdY = vh - bdH;
    const bdGrad = ctx.createLinearGradient(0, bdY, 0, vh);
    bdGrad.addColorStop(0, "rgba(4, 9, 20, 0)");
    bdGrad.addColorStop(0.5, "rgba(4, 9, 20, 0.65)");
    bdGrad.addColorStop(1, "rgba(4, 9, 20, 0.92)");
    ctx.fillStyle = bdGrad;
    ctx.fillRect(0, bdY, vw, bdH);
    // Top hairline
    ctx.fillStyle = "rgba(255, 210, 74, 0.35)";
    ctx.fillRect(0, bdY, vw, 1);
    ctx.fillStyle = "rgba(255, 210, 74, 0.08)";
    ctx.fillRect(0, bdY + 1, vw, 1);
    ctx.restore();

    // Floor track for XP — flat, no rounded corners (true edge-bleed)
    ctx.save();
    ctx.fillStyle = "rgba(8, 14, 26, 0.92)";
    ctx.fillRect(xpX, xpY, xpW, xpH);

    // Fill
    const xpFillW = xpW * clamp(hs.xpDisplay, 0, 1);
    if (xpFillW > 0) {
      const fg = ctx.createLinearGradient(0, xpY, 0, xpY + xpH);
      fg.addColorStop(0, "#fff2a8");
      fg.addColorStop(0.45, "#ffd24a");
      fg.addColorStop(1, "#ff9a1f");
      // Glow under fill
      ctx.save();
      ctx.shadowColor = "#ffd24a";
      ctx.shadowBlur = 18 + hs.xpFlash * 22;
      ctx.fillStyle = fg;
      ctx.fillRect(xpX, xpY, xpFillW, xpH);
      ctx.restore();
      ctx.fillStyle = fg;
      ctx.fillRect(xpX, xpY, xpFillW, xpH);

      // Top sheen highlight (1/3 of bar)
      const sheenG = ctx.createLinearGradient(0, xpY, 0, xpY + xpH * 0.55);
      sheenG.addColorStop(0, "rgba(255, 255, 255, 0.4)");
      sheenG.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = sheenG;
      ctx.fillRect(xpX, xpY, xpFillW, xpH * 0.55);

      // Animated sheen sweep
      ctx.save();
      ctx.beginPath();
      ctx.rect(xpX, xpY, xpFillW, xpH);
      ctx.clip();
      const sweep = ((t * 0.18) % 1) * (xpFillW + 200) - 100;
      const sg = ctx.createLinearGradient(sweep - 80, 0, sweep + 80, 0);
      sg.addColorStop(0, "rgba(255, 255, 255, 0)");
      sg.addColorStop(0.5, "rgba(255, 255, 255, 0.32)");
      sg.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = sg;
      ctx.fillRect(sweep - 80, xpY, 160, xpH);
      ctx.restore();

      // Leading-edge flash on XP gain
      if (hs.xpFlash > 0.02 && xpFillW < xpW) {
        ctx.save();
        ctx.globalAlpha = hs.xpFlash;
        const eg = ctx.createRadialGradient(xpFillW, xpY + xpH / 2, 0, xpFillW, xpY + xpH / 2, 36);
        eg.addColorStop(0, "rgba(255, 255, 220, 0.85)");
        eg.addColorStop(1, "rgba(255, 210, 74, 0)");
        ctx.fillStyle = eg;
        ctx.fillRect(xpFillW - 36, xpY - 8, 72, xpH + 16);
        ctx.restore();
      }
    }

    // Tick marks — kinetic segments
    const tickCount = vw < 700 ? 12 : vw < 1100 ? 20 : 28;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
    ctx.lineWidth = 1;
    for (let i = 1; i < tickCount; i += 1) {
      const tickX = (xpW * i) / tickCount;
      ctx.beginPath();
      ctx.moveTo(tickX, xpY + 3);
      ctx.lineTo(tickX, xpY + xpH - 3);
      ctx.stroke();
    }

    // Top + bottom hairlines on bar
    ctx.fillStyle = "rgba(255, 240, 180, 0.55)";
    ctx.fillRect(xpX, xpY, xpW, 1);
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.fillRect(xpX, xpY + xpH - 1, xpW, 1);
    ctx.restore();

    // Level-up wave: bright gaussian sweep along the entire bar
    if (hs.levelFlash > 0.02) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(xpX, xpY - 2, xpW, xpH + 4);
      ctx.clip();
      const waveT = 1 - hs.levelFlash; // 0 -> 1 over the flash duration
      const waveX = waveT * (xpW + 240) - 120;
      const wg = ctx.createLinearGradient(waveX - 160, 0, waveX + 160, 0);
      wg.addColorStop(0, "rgba(255, 255, 255, 0)");
      wg.addColorStop(0.5, `rgba(255, 255, 255, ${0.85 * Math.min(1, hs.levelFlash * 1.6)})`);
      wg.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = wg;
      ctx.fillRect(waveX - 160, xpY - 2, 320, xpH + 4);
      ctx.restore();
    }

    // LEVEL chip — bottom-left, overlapping the XP bar's left edge
    const chipH = 30;
    const chipW = 84;
    const chipX = pad;
    const chipY = xpY + (xpH - chipH) / 2;
    this.drawHexChip(chipX, chipY, chipW, chipH, "#ffc857", `LV ${player.level}`, hs.levelFlash);

    // EXPERIENCE label + value — bottom-right
    ctx.save();
    ctx.font = "900 9px Inter, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 230, 160, 0.7)";
    ctx.textAlign = "right";
    ctx.fillText("EXPERIENCE", vw - pad, xpY - 8);
    ctx.font = "900 14px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#ffeed1";
    ctx.shadowColor = "rgba(255, 210, 74, 0.7)";
    ctx.shadowBlur = 8;
    ctx.fillText(`${Math.floor(player.xp)} / ${player.nextLevelXp}`, vw - pad, xpY + xpH + 16);
    ctx.shadowBlur = 0;
    ctx.restore();

    // In-run scrap counter — left of EXPERIENCE
    ctx.save();
    const scrapVal = Math.floor(player.scrap ?? 0);
    ctx.font = "900 9px Inter, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 200, 87, 0.7)";
    ctx.textAlign = "right";
    const scrapRightX = vw - pad - 130;
    ctx.fillText("SCRAP", scrapRightX, xpY - 8);
    ctx.font = "900 14px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#ffd9a3";
    ctx.shadowColor = "rgba(255, 176, 32, 0.6)";
    ctx.shadowBlur = 8;
    ctx.fillText(`⬢ ${scrapVal}`, scrapRightX, xpY + xpH + 16);
    ctx.shadowBlur = 0;
    ctx.restore();

    // Vignette pulse on heavy damage
    if (hs.damagePulse > 0.05) {
      const a = hs.damagePulse * 0.32;
      const grad = ctx.createRadialGradient(
        vw / 2,
        vh / 2,
        Math.min(vw, vh) * 0.35,
        vw / 2,
        vh / 2,
        Math.max(vw, vh) * 0.7,
      );
      grad.addColorStop(0, "rgba(255, 60, 90, 0)");
      grad.addColorStop(1, `rgba(255, 60, 90, ${a})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, vw, vh);
    }

    // Level-up top-edge band (companion to the bottom wave)
    if (hs.levelFlash > 0.02) {
      ctx.save();
      ctx.globalAlpha = hs.levelFlash * 0.55;
      const lg = ctx.createLinearGradient(0, 0, vw, 0);
      lg.addColorStop(0, "rgba(255, 210, 74, 0)");
      lg.addColorStop(0.5, "rgba(255, 210, 74, 0.5)");
      lg.addColorStop(1, "rgba(255, 210, 74, 0)");
      ctx.fillStyle = lg;
      ctx.fillRect(0, 0, vw, 4);
      ctx.restore();
    }

    ctx.restore();
  }

  drawBossHud(snapshot, pad, elapsed) {
    const bosses = snapshot.enemies.filter((enemy) => enemy.rank === "boss" && enemy.hp > 0);
    if (!bosses.length) return;
    const boss = bosses.reduce((lowest, enemy) => (enemy.hp / enemy.maxHp < lowest.hp / lowest.maxHp ? enemy : lowest), bosses[0]);
    const ctx = this.ctx;
    const width = Math.min(564, this.viewport.width - pad * 2);
    const barWidth = Math.max(180, width - 44);
    const height = 18;
    const x = (this.viewport.width - width) / 2;
    const barX = x + 44;
    const y = this.viewport.width < 760 ? pad + 126 : pad + 84;
    const health = clamp(boss.hp / Math.max(1, boss.maxHp), 0, 1);
    const accent = bossColor(boss);
    const chipAccent = health < 0.25 ? mixHex(accent, "#ff5b79", 0.5 + Math.sin(elapsed * Math.PI * 4) * 0.5) : accent;
    ctx.save();
    chamferedRectPath(ctx, x, y - 9, 36, 36, 7);
    ctx.fillStyle = "rgba(4, 9, 20, 0.85)";
    ctx.fill();
    ctx.strokeStyle = chipAccent;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    this.drawBossPortrait(boss, x + 18, y + 9, 32, 32);
    ctx.font = "900 10px Inter, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255, 238, 241, 0.86)";
    ctx.fillText(formatBossName(boss), barX, y - 6);
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255, 178, 192, 0.78)";
    ctx.fillText(`PHASE ${boss.phase ?? 1}`, barX + barWidth, y - 6);
    this.drawStatBar(barX, y, barWidth, height, health, accent, {
      label: "",
      value: "",
      glow: 0.9 + Math.sin(elapsed * 5) * 0.18,
      ticks: 8,
      time: elapsed,
    });
    ctx.restore();
  }

  drawRunEventAlert(snapshot) {
    const alert = snapshot.runEvents?.alert;
    const activeEvent = snapshot.runEvents?.active?.find((event) => snapshot.elapsed < event.triggerAt) ?? null;
    if (!alert && !activeEvent) return;
    const ctx = this.ctx;
    const vw = this.viewport.width;
    const pad = vw < 520 ? 10 : 18;
    const width = vw < 560 ? Math.min(300, vw - pad * 2) : 330;
    const height = 46;
    const x = vw / 2 - width / 2;
    const y = vw >= 720 ? 82 : 132;
    const label = activeEvent?.label ?? alert?.label ?? "RUN EVENT";
    const remaining = Math.max(0, activeEvent ? activeEvent.triggerAt - snapshot.elapsed : alert?.timeRemaining ?? 0);
    const pulse = 0.55 + Math.sin(snapshot.elapsed * 9) * 0.25;

    ctx.save();
    this.drawNeonPanel(x, y, width, height, "#ffc857", 0.58 + pulse * 0.12, 8);
    this.drawUiIcon("warning", x + 25, y + height / 2, 28, 24);
    ctx.font = "900 10px Inter, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 210, 74, 0.78)";
    ctx.textAlign = "left";
    ctx.fillText("EVENT WARNING", x + 48, y + 17);
    ctx.font = "900 15px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#fff3cf";
    ctx.shadowColor = "rgba(255, 200, 87, 0.65)";
    ctx.shadowBlur = 8;
    ctx.fillText(label.toUpperCase(), x + 48, y + 34);
    ctx.shadowBlur = 0;
    ctx.textAlign = "right";
    ctx.font = "900 18px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#ff5b79";
    ctx.fillText(`${remaining.toFixed(1)}s`, x + width - 14, y + 30);
    ctx.restore();
  }

  drawNeonPanel(x, y, width, height, accent = "#64d9ff", alpha = 0.58, cut = 12) {
    const ctx = this.ctx;
    ctx.save();
    // Outer glow
    ctx.shadowColor = accent;
    ctx.shadowBlur = 18;
    ctx.fillStyle = `rgba(4, 9, 20, ${alpha})`;
    chamferedRectPath(ctx, x, y, width, height, cut);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Inner gradient overlay
    const grad = ctx.createLinearGradient(x, y, x, y + height);
    grad.addColorStop(0, "rgba(255, 255, 255, 0.06)");
    grad.addColorStop(1, "rgba(0, 0, 0, 0.18)");
    ctx.fillStyle = grad;
    chamferedRectPath(ctx, x, y, width, height, cut);
    ctx.fill();
    // Outline
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = hexToRgba(accent, 0.55);
    chamferedRectPath(ctx, x + 0.5, y + 0.5, width - 1, height - 1, cut);
    ctx.stroke();
    // Inner subtle stroke
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    chamferedRectPath(ctx, x + 4, y + 4, width - 8, height - 8, cut - 4);
    ctx.stroke();
    // Corner ticks
    ctx.strokeStyle = hexToRgba(accent, 0.85);
    ctx.lineWidth = 1.4;
    const tick = 8;
    ctx.beginPath();
    ctx.moveTo(x + cut + 4, y); ctx.lineTo(x + cut + 4 + tick, y);
    ctx.moveTo(x + width - cut - 4, y); ctx.lineTo(x + width - cut - 4 - tick, y);
    ctx.moveTo(x + cut + 4, y + height); ctx.lineTo(x + cut + 4 + tick, y + height);
    ctx.moveTo(x + width - cut - 4, y + height); ctx.lineTo(x + width - cut - 4 - tick, y + height);
    ctx.stroke();
    ctx.restore();
  }

  drawHexChip(x, y, width, height, color, text, flash = 0) {
    const ctx = this.ctx;
    ctx.save();
    const slant = 6;
    ctx.beginPath();
    ctx.moveTo(x + slant, y);
    ctx.lineTo(x + width, y);
    ctx.lineTo(x + width - slant, y + height);
    ctx.lineTo(x, y + height);
    ctx.closePath();
    const grad = ctx.createLinearGradient(x, y, x, y + height);
    grad.addColorStop(0, hexToRgba(color, 0.95));
    grad.addColorStop(1, hexToRgba(color, 0.55));
    ctx.fillStyle = grad;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8 + flash * 14;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(20, 12, 0, 0.55)";
    ctx.stroke();
    ctx.font = "900 11px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#1a1206";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + width / 2 - slant / 2, y + height / 2 + 0.5);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.restore();
  }

  drawStatBar(x, y, width, height, amount, color, opts = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = "800 10px Inter, system-ui, sans-serif";
    ctx.fillStyle = "rgba(237, 247, 255, 0.92)";
    ctx.textAlign = "left";
    ctx.fillText(opts.label ?? "", x, y - 4);
    ctx.fillStyle = "rgba(180, 198, 218, 0.85)";
    ctx.textAlign = "right";
    ctx.fillText(opts.value ?? "", x + width, y - 4);
    ctx.textAlign = "left";

    const r = height / 2;
    // Track
    ctx.fillStyle = "rgba(8, 14, 26, 0.85)";
    roundRectPath(ctx, x, y, width, height, r);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
    ctx.lineWidth = 1;
    roundRectPath(ctx, x + 0.5, y + 0.5, width - 1, height - 1, r);
    ctx.stroke();

    const fillW = width * clamp(amount, 0, 1);

    // Glow under fill
    if (fillW > 1 && opts.glow) {
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 10 + (opts.glow ?? 0) * 14;
      ctx.fillStyle = color;
      roundRectPath(ctx, x, y, fillW, height, r);
      ctx.fill();
      ctx.restore();
    }

    // Gradient fill
    if (fillW > 1) {
      let fillStyle = color;
      if (opts.gradient) {
        const g = ctx.createLinearGradient(x, y, x, y + height);
        g.addColorStop(0, opts.gradient[0]);
        g.addColorStop(0.5, opts.gradient[1]);
        g.addColorStop(1, opts.gradient[2]);
        fillStyle = g;
      } else {
        const g = ctx.createLinearGradient(x, y, x, y + height);
        g.addColorStop(0, lighten(color, 0.35));
        g.addColorStop(1, color);
        fillStyle = g;
      }
      ctx.fillStyle = fillStyle;
      roundRectPath(ctx, x, y, fillW, height, r);
      ctx.fill();

      // Top sheen highlight
      ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
      roundRectPath(ctx, x + 1, y + 1, fillW - 2, Math.max(1, height * 0.32), r);
      ctx.fill();

      // Animated sheen sweep (yellow XP bar especially)
      if (opts.sheen) {
        const t = opts.time ?? 0;
        const sweep = ((t * 0.32) % 1) * (fillW + 60) - 30;
        ctx.save();
        roundRectPath(ctx, x, y, fillW, height, r);
        ctx.clip();
        const sg = ctx.createLinearGradient(x + sweep - 30, 0, x + sweep + 30, 0);
        sg.addColorStop(0, "rgba(255, 255, 255, 0)");
        sg.addColorStop(0.5, "rgba(255, 255, 255, 0.45)");
        sg.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.fillStyle = sg;
        ctx.fillRect(x + sweep - 30, y, 60, height);
        ctx.restore();
      }
    }

    // Shield overlay
    if (opts.shield && opts.shield > 0.001) {
      const shieldW = Math.min(width, fillW + width * opts.shield);
      const start = Math.max(0, fillW - 1);
      ctx.save();
      roundRectPath(ctx, x, y, width, height, r);
      ctx.clip();
      const sg = ctx.createLinearGradient(x, y, x, y + height);
      sg.addColorStop(0, hexToRgba(opts.shieldColor ?? "#7df3ff", 0.85));
      sg.addColorStop(1, hexToRgba(opts.shieldColor ?? "#7df3ff", 0.55));
      ctx.fillStyle = sg;
      ctx.fillRect(x + start, y, shieldW - start, height);
      // Diagonal shield hatching
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 1;
      const t = opts.time ?? 0;
      for (let sx = -height; sx < shieldW + height; sx += 6) {
        const ox = sx + ((t * 18) % 6);
        ctx.beginPath();
        ctx.moveTo(x + start + ox, y);
        ctx.lineTo(x + start + ox - height, y + height);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Tick marks
    if (opts.ticks && opts.ticks > 1) {
      ctx.save();
      ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
      ctx.lineWidth = 1;
      for (let i = 1; i < opts.ticks; i += 1) {
        const tx = x + (width * i) / opts.ticks;
        ctx.beginPath();
        ctx.moveTo(tx, y + 2);
        ctx.lineTo(tx, y + height - 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Outline
    ctx.lineWidth = 1;
    ctx.strokeStyle = hexToRgba(color, 0.55);
    roundRectPath(ctx, x + 0.5, y + 0.5, width - 1, height - 1, r);
    ctx.stroke();

    // XP flash burst at the leading edge
    if (opts.yellow && opts.flash > 0.02 && fillW > 2) {
      ctx.save();
      ctx.globalAlpha = opts.flash;
      const fg = ctx.createRadialGradient(x + fillW, y + height / 2, 0, x + fillW, y + height / 2, 24);
      fg.addColorStop(0, "rgba(255, 255, 220, 0.9)");
      fg.addColorStop(1, "rgba(255, 210, 74, 0)");
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(x + fillW, y + height / 2, 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  drawStatTile(x, y, width, height, icon, label, value, accent) {
    const ctx = this.ctx;
    this.drawNeonPanel(x, y, width, height, accent, 0.5, 8);
    ctx.save();
    // Accent top stripe — flat-with-glow modern feel
    ctx.fillStyle = hexToRgba(accent, 0.85);
    ctx.fillRect(x + 10, y + 6, Math.max(20, width * 0.28), 2);
    ctx.shadowColor = accent;
    ctx.shadowBlur = 8;
    ctx.fillRect(x + 10, y + 6, Math.max(20, width * 0.28), 2);
    ctx.shadowBlur = 0;

    if (icon) this.drawUiIcon(icon, x + width - 22, y + 22, 20, 20);
    const tx = x + 12;
    const tall = height >= 60;
    ctx.font = "900 9px Inter, system-ui, sans-serif";
    ctx.fillStyle = hexToRgba(accent, 0.9);
    ctx.textAlign = "left";
    ctx.fillText(label, tx, y + 22);
    ctx.font = tall ? "900 26px Inter, system-ui, sans-serif" : "900 20px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#edf7ff";
    ctx.shadowColor = hexToRgba(accent, 0.75);
    ctx.shadowBlur = 8;
    ctx.fillText(value, tx, y + height - 12);
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  drawGameOver(snapshot) {
    const ctx = this.ctx;
    const w = this.viewport.width;
    const h = this.viewport.height;
    this.hudState.gameOverIn = Math.min(1, this.hudState.gameOverIn + 0.04);
    const t = this.hudState.gameOverIn;
    const elapsed = this.lastElapsed;
    const victory = snapshot.state === "victory" || snapshot.outcome === "victory";
    const accent = victory ? "#64d9ff" : "#ff5b79";
    const secondary = victory ? "#ffd24a" : "#64d9ff";

    ctx.save();

    // Vignette + scanlines
    const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    grad.addColorStop(0, victory ? `rgba(0, 34, 48, ${0.5 * t})` : `rgba(40, 0, 12, ${0.5 * t})`);
    grad.addColorStop(1, `rgba(2, 4, 10, ${0.92 * t})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.globalAlpha = 0.18 * t;
    ctx.fillStyle = accent;
    for (let y = 0; y < h; y += 4) {
      ctx.fillRect(0, y, w, 1);
    }
    ctx.globalAlpha = 1;

    // Glitch title (offset chromatic copies)
    ctx.textAlign = "center";
    const title = victory ? "RUN COMPLETE" : "SIGNAL LOST";
    const titleY = h / 2 - 30;
    const jitter = (Math.sin(elapsed * 12) * 2 + Math.sin(elapsed * 33) * 1.4) * t;
    ctx.font = "900 64px Inter, system-ui, sans-serif";
    ctx.fillStyle = hexToRgba(secondary, 0.7 * t);
    ctx.fillText(title, w / 2 - 4 + jitter, titleY);
    ctx.fillStyle = hexToRgba(accent, 0.7 * t);
    ctx.fillText(title, w / 2 + 4 - jitter, titleY);
    ctx.fillStyle = `rgba(255, 248, 240, ${t})`;
    ctx.shadowColor = hexToRgba(accent, 0.8);
    ctx.shadowBlur = 24;
    ctx.fillText(title, w / 2, titleY);
    ctx.shadowBlur = 0;

    // Subtitle bar
    ctx.font = "800 12px Inter, system-ui, sans-serif";
    ctx.fillStyle = `rgba(255, 200, 87, ${t})`;
    ctx.fillText(victory ? "// EXTRACTION WINDOW REACHED //" : "// MISSION TERMINATED //", w / 2, titleY + 26);

    // Stats panel
    const reward = snapshot.runReward ?? null;
    const pw = 620;
    const ph = 110;
    const px = w / 2 - pw / 2;
    const py = titleY + 50;
    ctx.globalAlpha = t;
    this.drawNeonPanel(px, py, pw, ph, accent, 0.78, 14);

    const cells = [
      { label: "SURVIVED", value: formatTime(elapsed), color: "#64d9ff" },
      { label: "WAVE REACHED", value: String(snapshot.wave), color: "#b86cff" },
      { label: "FINAL LEVEL", value: String(snapshot.players?.[0]?.level ?? 1), color: "#ffd24a" },
      { label: "SCRAP EARNED", value: reward ? `${Math.round(reward.scrap)} ⬢` : "— ⬢", color: "#ffb020" },
    ];
    const cellW = pw / cells.length;
    cells.forEach((cell, i) => {
      const cx = px + i * cellW + cellW / 2;
      ctx.font = "800 11px Inter, system-ui, sans-serif";
      ctx.fillStyle = hexToRgba(cell.color, 0.85);
      ctx.fillText(cell.label, cx, py + 36);
      ctx.font = "900 30px Inter, system-ui, sans-serif";
      ctx.fillStyle = "#edf7ff";
      ctx.shadowColor = hexToRgba(cell.color, 0.7);
      ctx.shadowBlur = 12;
      ctx.fillText(cell.value, cx, py + 76);
      ctx.shadowBlur = 0;
      if (i < cells.length - 1) {
        ctx.strokeStyle = hexToRgba(accent, 0.3);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px + (i + 1) * cellW, py + 18);
        ctx.lineTo(px + (i + 1) * cellW, py + ph - 18);
        ctx.stroke();
      }
    });

    if (reward?.breakdown) {
      const b = reward.breakdown;
      const secPart = `${b.seconds}s × 0.75`;
      const killPart = `${b.kills} kills × 4`;
      const wavePart = `wave ${snapshot.wave} × 35`;
      const collectedPart = `${b.collected} collected`;
      const breakdownLine = `${secPart} + ${killPart} + ${wavePart} + ${collectedPart} = ${Math.round(reward.scrap)}`;
      ctx.font = "700 12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(237, 247, 255, 0.78)";
      ctx.fillText(breakdownLine, w / 2, py + ph + 22);
      if (b.charterBonus > 0) {
        ctx.fillStyle = "rgba(255, 200, 87, 0.85)";
        ctx.fillText(`(+${Math.round(b.charterBonus * 100)}% Charter)`, w / 2, py + ph + 40);
      }
    }

    ctx.font = "800 11px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(100, 217, 255, 0.78)";
    ctx.fillText("Open Armory to spend", w / 2, py + ph + (reward?.breakdown?.charterBonus > 0 ? 60 : 44));
    ctx.textAlign = "left";

    ctx.globalAlpha = 1;

    ctx.restore();
  }

  drawSprite(name, x, y, width, height, rotation = 0) {
    if (!this.sprites.ready) return false;
    const sprite = SPRITE_SHEET.sprites[name];
    if (!sprite) return false;

    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    if (rotation) ctx.rotate(rotation);
    ctx.drawImage(
      this.sprites.image,
      sprite.x,
      sprite.y,
      sprite.width,
      sprite.height,
      -width / 2,
      -height / 2,
      width,
      height,
    );
    ctx.restore();
    return true;
  }

  drawUiIcon(name, x, y, width, height, rotation = 0) {
    return this.drawSheetSprite(this.uiSprites, UI_SHEET.sprites, name, x, y, width, height, rotation);
  }

  drawBossPortrait(enemy, x, y, width, height) {
    const key = bossPortraitSpriteName(enemy);
    const image = this.bossPortraitImages[key];
    if (image?.ready) return this.drawImageSprite(image.image, x, y, width, height, 0);
    return false;
  }

  drawEnemySprite(name, x, y, width, height, rotation = 0) {
    if (SPRITE_SHEET.sprites[name]) return this.drawSprite(name, x, y, width, height, rotation);
    const bossImage = this.bossImages[name];
    if (bossImage?.ready) return this.drawImageSprite(bossImage.image, x, y, width, height, rotation);
    const image = this.enemyImages[name];
    if (image?.ready) return this.drawImageSprite(image.image, x, y, width, height, rotation);
    return this.drawSheetSprite(this.enemySprites, ENEMY_SHEET.sprites, name, x, y, width, height, rotation);
  }

  drawImageSprite(image, x, y, width, height, rotation = 0) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    if (rotation) ctx.rotate(rotation);
    ctx.drawImage(image, -width / 2, -height / 2, width, height);
    ctx.restore();
    return true;
  }

  drawSheetSprite(sheet, sprites, name, x, y, width, height, rotation = 0) {
    if (!sheet.ready) return false;
    const sprite = sprites[name];
    if (!sprite) return false;

    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    if (rotation) ctx.rotate(rotation);
    ctx.drawImage(sheet.image, sprite.x, sprite.y, sprite.width, sprite.height, -width / 2, -height / 2, width, height);
    ctx.restore();
    return true;
  }

  drawGlow(x, y, radius, color) {
    const gradient = this.ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    this.ctx.fillStyle = gradient;
    this.ctx.beginPath();
    this.ctx.arc(x, y, radius, 0, Math.PI * 2);
    this.ctx.fill();
  }

  drawPanel(x, y, width, height, alpha = 0.56) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = `rgba(4, 10, 22, ${alpha})`;
    ctx.strokeStyle = "rgba(100, 217, 255, 0.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    roundRect(ctx, x, y, width, height, 8);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
    ctx.strokeRect(x + 5, y + 5, width - 10, height - 10);
    ctx.restore();
  }

  drawLabeledBar(x, y, width, height, amount, color, label, value) {
    const ctx = this.ctx;
    ctx.font = "800 12px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#edf7ff";
    ctx.fillText(label, x, y - 6);
    ctx.fillStyle = "#91a8bd";
    ctx.textAlign = "right";
    ctx.fillText(value, x + width, y - 6);
    ctx.textAlign = "left";
    drawBar(ctx, x, y, width, height, amount, color);
  }

  pixelAlignedCamera() {
    const pixelsPerWorldUnit = this.camera.scale * this.viewport.dpr;
    if (!pixelsPerWorldUnit) return this.camera;
    return {
      x: Math.round(this.camera.x * pixelsPerWorldUnit) / pixelsPerWorldUnit,
      y: Math.round(this.camera.y * pixelsPerWorldUnit) / pixelsPerWorldUnit,
      scale: this.camera.scale,
    };
  }

  random() {
    this.particleSeed = (1664525 * this.particleSeed + 1013904223) >>> 0;
    return this.particleSeed / 0x100000000;
  }

  randomRange(min, max) {
    return min + (max - min) * this.random();
  }
}

function createStarfield(count) {
  return Array.from({ length: count }, (_, index) => ({
    x: ((index * 977) % 4400) - 2200,
    y: ((index * 613) % 2800) - 1400,
    radius: 0.9 + ((index * 17) % 22) / 15,
    alpha: 0.3 + ((index * 29) % 60) / 100,
    depth: 0.08 + ((index * 37) % 70) / 100,
    color: index % 9 === 0 ? "#ffc857" : index % 5 === 0 ? "#64d9ff" : "#ffffff",
  }));
}

function drawBar(ctx, x, y, width, height, amount, color) {
  ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
  ctx.beginPath();
  roundRect(ctx, x, y, width, height, height / 2);
  ctx.fill();
  ctx.fillStyle = color;
  const fillWidth = width * clamp(amount, 0, 1);
  if (fillWidth > 0.5) {
    ctx.beginPath();
    roundRect(ctx, x, y, fillWidth, height, height / 2);
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.beginPath();
  roundRect(ctx, x, y, width, height, height / 2);
  ctx.stroke();
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatDamage(value) {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  if (value > 0 && value < 1) return Math.max(0.1, value).toFixed(1);
  return String(Math.round(value));
}

function numericId(id) {
  return String(id)
    .split("")
    .reduce((total, char) => total + char.charCodeAt(0), 0);
}

function bossTelegraphProgress(enemy, type, elapsed, duration) {
  if (enemy.bossTelegraph?.type !== type) return 0;
  return clamp((elapsed - enemy.bossTelegraph.startedAt) / Math.max(0.001, duration), 0, 1);
}

function drawShardGlyph(ctx, x, y, radius, rotation) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.beginPath();
  ctx.moveTo(radius * 1.5, 0);
  ctx.lineTo(-radius * 0.35, -radius);
  ctx.lineTo(-radius * 0.85, 0);
  ctx.lineTo(-radius * 0.35, radius);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function polygonPath(ctx, x, y, radius, sides, rotation = 0) {
  ctx.beginPath();
  for (let i = 0; i < sides; i += 1) {
    const angle = rotation + (Math.PI * 2 * i) / sides;
    const px = x + Math.cos(angle) * radius;
    const py = y + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function seededNoise(seed, index, frame) {
  const value = Math.sin(seed * 12.9898 + index * 78.233 + frame * 37.719) * 43758.5453;
  return value - Math.floor(value);
}

function mixHex(a, b, t) {
  const ar = Number.parseInt(a.slice(1, 3), 16);
  const ag = Number.parseInt(a.slice(3, 5), 16);
  const ab = Number.parseInt(a.slice(5, 7), 16);
  const br = Number.parseInt(b.slice(1, 3), 16);
  const bg = Number.parseInt(b.slice(3, 5), 16);
  const bb = Number.parseInt(b.slice(5, 7), 16);
  const mix = (from, to) => Math.round(from + (to - from) * clamp(t, 0, 1)).toString(16).padStart(2, "0");
  return `#${mix(ar, br)}${mix(ag, bg)}${mix(ab, bb)}`;
}

function enemySpriteName(enemy) {
  if (enemy.rank === "boss" || enemy.bossId) return bossSpriteName(enemy);
  if (enemy.type === "drone") return "enemyDrone";
  if (enemy.type === "bruiser") return "enemyBruiser";
  if (enemy.type === "charger") return "enemyCharger";
  if (enemy.type === "siphon") return "enemySiphon";
  if (enemy.type === "warden") return "enemyWarden";
  if (enemy.type === "splitter") return "enemySplitter";
  if (enemy.type === "stalker") return "enemyStalker";
  if (enemy.type === "spitter") return "enemySpitter";
  if (enemy.type === "bulwark") return "enemyBulwark";
  if (enemy.type === "shard") return "enemyShard";
  return null;
}

function bossSpriteName(enemy) {
  if (enemy.bossId === "brood-splitter") return "bossBroodSplitter";
  if (enemy.bossId === "siphon-prime") return "bossSiphonPrime";
  if (enemy.bossId === "bastion-bulwark") return "bossBastionBulwark";
  if (enemy.bossId === "nova-spitter") return "bossNovaSpitter";
  return null;
}

function bossPortraitSpriteName(enemy) {
  if (enemy.bossId === "brood-splitter") return "portraitBroodSplitter";
  if (enemy.bossId === "siphon-prime") return "portraitSiphonPrime";
  if (enemy.bossId === "bastion-bulwark") return "portraitBastionBulwark";
  if (enemy.bossId === "nova-spitter") return "portraitNovaSpitter";
  return null;
}

function enemyDrawWidth(enemy) {
  if (enemy.type === "bulwark") return 58;
  if (enemy.type === "bruiser") return 62;
  if (enemy.type === "charger") return 50;
  if (enemy.type === "siphon") return 48;
  if (enemy.type === "warden") return 54;
  if (enemy.type === "splitter") return 48;
  if (enemy.type === "spitter") return 44;
  if (enemy.type === "stalker") return 38;
  if (enemy.type === "shard") return 28;
  return 42;
}

function enemyDrawHeight(enemy) {
  if (enemy.type === "bulwark") return 58;
  if (enemy.type === "bruiser") return 68;
  if (enemy.type === "charger") return 40;
  if (enemy.type === "siphon") return 52;
  if (enemy.type === "warden") return 56;
  if (enemy.type === "splitter") return 46;
  if (enemy.type === "spitter") return 42;
  if (enemy.type === "stalker") return 44;
  if (enemy.type === "shard") return 25;
  return 37;
}

function enemyFillColor(enemy) {
  if (enemy.type === "bulwark") return "#7c88ff";
  if (enemy.type === "bruiser") return "#ab5cff";
  if (enemy.type === "charger") return "#ff4d2e";
  if (enemy.type === "siphon") return "#25d6ff";
  if (enemy.type === "warden") return "#ffe36e";
  if (enemy.type === "stalker") return "#36f0b8";
  if (enemy.type === "spitter") return "#d7ff57";
  if (enemy.type === "splitter") return "#ff9a3d";
  if (enemy.type === "shard") return "#ffcf57";
  return "#ff5b79";
}

function bossColor(enemy) {
  if (enemy.bossId === "brood-splitter") return "#ff9a3d";
  if (enemy.bossId === "siphon-prime") return "#25d6ff";
  if (enemy.bossId === "bastion-bulwark") return "#7c88ff";
  if (enemy.bossId === "nova-spitter") return "#d7ff57";
  return "#ff5b79";
}

function bossAuraColor(enemy) {
  if (enemy.bossId === "brood-splitter") return "rgba(255, 154, 61, 0.78)";
  if (enemy.bossId === "siphon-prime") return "rgba(37, 214, 255, 0.76)";
  if (enemy.bossId === "bastion-bulwark") return "rgba(124, 136, 255, 0.78)";
  if (enemy.bossId === "nova-spitter") return "rgba(215, 255, 87, 0.74)";
  return "rgba(255, 91, 121, 0.78)";
}

function formatBossName(enemy) {
  const id = enemy.bossId ?? enemy.eliteId ?? enemy.type;
  return id
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function enemyGlowColor(enemy) {
  if (enemy.rank === "boss") return bossAuraColor(enemy);
  if (enemy.rank === "elite" || enemy.eliteId) return "rgba(255, 200, 87, 0.3)";
  if (enemy.affixes?.includes("volatile")) return "rgba(255, 91, 121, 0.32)";
  if (enemy.affixes?.includes("regenerating")) return "rgba(60, 255, 148, 0.28)";
  if (enemy.affixes?.includes("armored") || enemy.eliteAffix === "armored") return "rgba(140, 245, 255, 0.28)";
  if (enemy.affixes?.includes("hasted") || enemy.eliteAffix === "swift") return "rgba(255, 211, 92, 0.28)";
  if (enemy.type === "bulwark") return "rgba(124, 136, 255, 0.24)";
  if (enemy.type === "bruiser") return "rgba(184, 108, 255, 0.22)";
  if (enemy.type === "charger") return "rgba(255, 77, 46, 0.24)";
  if (enemy.type === "siphon") return "rgba(37, 214, 255, 0.24)";
  if (enemy.type === "warden") return "rgba(255, 227, 110, 0.25)";
  if (enemy.type === "stalker") return "rgba(54, 240, 184, 0.2)";
  if (enemy.type === "spitter") return "rgba(215, 255, 87, 0.2)";
  if (enemy.type === "splitter" || enemy.type === "shard") return "rgba(255, 154, 61, 0.24)";
  return "rgba(255, 75, 111, 0.22)";
}

function enemyGlowRadius(enemy) {
  if (enemy.rank === "boss") return enemy.radius + 76;
  if (enemy.rank === "elite" || enemy.eliteId) return enemy.radius + 58;
  if (enemy.affixes?.length || enemy.eliteAffix) return enemy.type === "bruiser" || enemy.type === "bulwark" ? 98 : 70 + (enemy.affixes?.length ?? 1) * 8;
  if (enemy.type === "bulwark") return 82;
  if (enemy.type === "bruiser") return 76;
  if (enemy.type === "charger") return 58;
  if (enemy.type === "siphon") return 62;
  if (enemy.type === "warden") return 72;
  if (enemy.type === "splitter") return 58;
  if (enemy.type === "stalker" || enemy.type === "spitter") return 52;
  if (enemy.type === "shard") return 36;
  return 48;
}

function affixAuraStyle(affix) {
  const styles = {
    hasted: {
      stroke: "rgba(255, 211, 92, 0.88)",
      dot: "rgba(255, 244, 166, 0.92)",
      dash: [8, 7],
      dots: 3,
      spin: 34,
      pulse: 8,
      dashDirection: 1,
    },
    swift: {
      stroke: "rgba(255, 211, 92, 0.88)",
      dot: "rgba(255, 244, 166, 0.92)",
      dash: [8, 7],
      dots: 3,
      spin: 34,
      pulse: 8,
      dashDirection: 1,
    },
    armored: {
      stroke: "rgba(140, 245, 255, 0.84)",
      dot: "rgba(204, 255, 255, 0.92)",
      dash: [],
      dots: 4,
      spin: 10,
      pulse: 3,
      dashDirection: -1,
    },
    regenerating: {
      stroke: "rgba(60, 255, 148, 0.82)",
      dot: "rgba(177, 255, 207, 0.92)",
      dash: [3, 6],
      dots: 5,
      spin: 18,
      pulse: 5,
      dashDirection: -1,
    },
    volatile: {
      stroke: "rgba(255, 91, 121, 0.88)",
      dot: "rgba(255, 200, 87, 0.94)",
      dash: [14, 4, 3, 4],
      dots: 6,
      spin: 24,
      pulse: 11,
      dashDirection: 1,
    },
  };
  return styles[affix] ?? styles.hasted;
}

function normalizeVector(x, y) {
  const length = Math.hypot(x, y);
  if (!length) return { x: 1, y: 0 };
  return { x: x / length, y: y / length };
}

function pickupStyle(type) {
  const styles = {
    xp: {
      sprite: "xpCrystal",
      size: 24,
      spin: 1.2,
      shape: "rect",
      fill: "#ffc857",
      glow: "rgba(255, 200, 87, 0.36)",
      glowRadius: 42,
      particle: "rgba(255, 207, 87, 0.58)",
      particleSize: 2,
    },
    scrap: {
      sprite: "xpCrystal",
      size: 22,
      spin: 0.8,
      shape: "rect",
      fill: "#b6c2cf",
      glow: "rgba(184, 194, 207, 0.32)",
      glowRadius: 38,
      particle: "rgba(198, 210, 220, 0.56)",
      particleSize: 1.9,
    },
    repair: {
      sprite: "shieldPickup",
      size: 34,
      spin: 0.15,
      shape: "circle",
      fill: "#55d6ff",
      glow: "rgba(85, 214, 255, 0.42)",
      glowRadius: 58,
      particle: "rgba(95, 222, 255, 0.58)",
      particleSize: 2.4,
    },
    shield: {
      sprite: "shieldPickup",
      size: 32,
      spin: 0.12,
      shape: "circle",
      fill: "#7df3ff",
      glow: "rgba(125, 243, 255, 0.38)",
      glowRadius: 54,
      particle: "rgba(125, 243, 255, 0.58)",
      particleSize: 2.3,
    },
    overdrive: {
      sprite: "xpCrystal",
      size: 28,
      spin: 2.4,
      shape: "rect",
      fill: "#ff5b79",
      glow: "rgba(255, 91, 121, 0.42)",
      glowRadius: 56,
      particle: "rgba(255, 91, 121, 0.62)",
      particleSize: 2.4,
    },
    magnet: {
      sprite: "xpCrystal",
      size: 28,
      spin: 1.7,
      shape: "circle",
      fill: "#9d7dff",
      glow: "rgba(157, 125, 255, 0.42)",
      glowRadius: 56,
      particle: "rgba(157, 125, 255, 0.62)",
      particleSize: 2.4,
    },
    cache: {
      sprite: "shieldPickup",
      size: 40,
      spin: 0.25,
      shape: "rect",
      fill: "#ffe38a",
      glow: "rgba(255, 227, 138, 0.48)",
      glowRadius: 70,
      particle: "rgba(255, 227, 138, 0.72)",
      particleSize: 2.8,
    },
  };
  return styles[type] ?? styles.xp;
}

function collectionEffectStyle(type) {
  const styles = {
    overdrive: {
      glow: "rgba(255, 91, 121, 0.34)",
      stroke: "rgba(255, 160, 168, 0.86)",
    },
    magnetBurst: {
      glow: "rgba(157, 125, 255, 0.32)",
      stroke: "rgba(207, 190, 255, 0.84)",
    },
    cacheOpened: {
      glow: "rgba(255, 227, 138, 0.38)",
      stroke: "rgba(255, 246, 184, 0.88)",
    },
  };
  return styles[type] ?? styles.overdrive;
}

function roundRectPath(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  roundRect(ctx, x, y, width, height, radius);
}

function chamferedRectPath(ctx, x, y, width, height, cut) {
  const c = Math.min(cut, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + width - c, y);
  ctx.lineTo(x + width, y + c);
  ctx.lineTo(x + width, y + height - c);
  ctx.lineTo(x + width - c, y + height);
  ctx.lineTo(x + c, y + height);
  ctx.lineTo(x, y + height - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

function hexToRgba(hex, alpha = 1) {
  if (hex.startsWith("rgba") || hex.startsWith("rgb")) return hex;
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lighten(hex, amount = 0.2) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  let r = parseInt(full.slice(0, 2), 16);
  let g = parseInt(full.slice(2, 4), 16);
  let b = parseInt(full.slice(4, 6), 16);
  r = Math.min(255, Math.round(r + (255 - r) * amount));
  g = Math.min(255, Math.round(g + (255 - g) * amount));
  b = Math.min(255, Math.round(b + (255 - b) * amount));
  return `rgb(${r}, ${g}, ${b})`;
}

function hpHealthColor(amount) {
  // green -> yellow -> red as HP depletes
  if (amount > 0.6) return "#4be08a";
  if (amount > 0.3) return "#ffc857";
  return "#ff4f73";
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function wrap(value, min, max) {
  const size = max - min;
  return ((((value - min) % size) + size) % size) + min;
}
