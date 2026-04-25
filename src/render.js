import { GAME } from "./config.js";
import { loadSpriteSheet, loadUiSheet, SPRITE_SHEET, UI_SHEET } from "./assets.js";
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

  render(snapshot) {
    const dt = clamp(snapshot.elapsed - this.lastElapsed, 0, 1 / 20);
    this.lastElapsed = snapshot.elapsed;
    const player = snapshot.players.find((item) => item.id === snapshot.localPlayerId) ?? snapshot.players[0];
    if (player) {
      this.camera.x += (player.x - this.camera.x) * 0.12;
      this.camera.y += (player.y - this.camera.y) * 0.12;
    }

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
    if (snapshot.state === "gameover") this.drawGameOver(snapshot);
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
    for (const effect of snapshot.effects ?? []) this.drawEffect(effect);
    for (const pickup of snapshot.pickups) this.drawPickup(pickup, snapshot.elapsed);
    for (const projectile of snapshot.projectiles) this.drawProjectile(projectile, snapshot.elapsed);
    for (const enemy of snapshot.enemies) this.drawEnemy(enemy, snapshot.elapsed);
    for (const player of snapshot.players) this.drawPlayer(player, snapshot.elapsed);
    this.drawDrones(snapshot);
    this.drawDamageNumbers();

    ctx.restore();
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
      this.drawGlow(projectile.x, projectile.y, 46, "rgba(100, 225, 255, 0.42)");
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
    const spriteName = enemy.type === "bruiser" ? "enemyBruiser" : "enemyDrone";
    const bob = Math.sin(elapsed * (enemy.type === "bruiser" ? 3.2 : 5.4) + numericId(enemy.id)) * 2.2;
    const pulse = 1 + Math.sin(elapsed * 4.5 + numericId(enemy.id)) * (enemy.type === "bruiser" ? 0.025 : 0.05);
    const hitFlash = clamp(enemy.hitFlash / 0.12, 0, 1);
    const hitScale = 1 + hitFlash * 0.16;
    const width = enemyDrawWidth(enemy) * pulse;
    const height = enemyDrawHeight(enemy) * pulse;
    const rotation =
      (enemy.type === "bruiser" ? Math.sin(elapsed * 1.8 + numericId(enemy.id)) * 0.04 : elapsed * 0.7) +
      hitFlash * 0.1;
    if (!this.drawSprite(spriteName, enemy.x, enemy.y + bob, width * hitScale, height * hitScale, rotation)) {
      ctx.fillStyle = enemyFillColor(enemy);
      ctx.beginPath();
      if (enemy.type === "splitter") {
        ctx.moveTo(enemy.x, enemy.y + bob - enemy.radius);
        ctx.lineTo(enemy.x + enemy.radius, enemy.y + bob + enemy.radius * 0.65);
        ctx.lineTo(enemy.x - enemy.radius, enemy.y + bob + enemy.radius * 0.65);
        ctx.closePath();
      } else {
        ctx.arc(enemy.x, enemy.y + bob, enemy.radius, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.24)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (enemy.eliteAffix) this.drawEliteRing(enemy, bob, elapsed);
    if (hitFlash > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = hitFlash * 0.72;
      ctx.fillStyle = enemy.type === "bruiser" ? "#f4b7ff" : "#ffffff";
      ctx.beginPath();
      ctx.arc(enemy.x, enemy.y + bob, enemy.radius * (1.25 + hitFlash * 0.35), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = "#1df2a4";
    ctx.fillRect(enemy.x - enemy.radius, enemy.y + bob - enemy.radius - 10, enemy.radius * 2 * health, 3);
  }

  drawEliteRing(enemy, bob, elapsed) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = enemy.eliteAffix === "armored" ? "rgba(140, 245, 255, 0.82)" : "rgba(255, 211, 92, 0.86)";
    ctx.lineWidth = 3;
    ctx.setLineDash(enemy.eliteAffix === "swift" ? [8, 7] : []);
    ctx.lineDashOffset = -elapsed * 24;
    ctx.beginPath();
    ctx.arc(enemy.x, enemy.y + bob, enemy.radius + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
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
    ctx.strokeStyle = "#8ff3ff";
    ctx.lineWidth = 5;
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
    if (effect.type !== "gravityWell" && effect.type !== "overdrive" && effect.type !== "magnetBurst" && effect.type !== "cacheOpened") return;
    const progress = 1 - effect.ttl / effect.duration;
    const alpha = 1 - progress;
    const size = effect.radius * (0.55 + progress * 0.7);
    this.ctx.save();
    this.ctx.globalAlpha = alpha * 0.78;
    if (effect.type === "gravityWell") {
      this.drawSprite("gravityWell", effect.x, effect.y, size, size);
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
      }
    }
    this.seenEffects = new Set([...this.seenEffects].filter((id) => activeIds.has(id)));
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
      ctx.font = "900 9px Inter, system-ui, sans-serif";
      ctx.fillStyle = "rgba(255, 178, 192, 0.7)";
      ctx.textAlign = "left";
      ctx.fillText("TARGETING DOCTRINE", tx + 64, ty + 18);
      ctx.font = "900 16px Inter, system-ui, sans-serif";
      ctx.fillStyle = "#ffeef1";
      ctx.fillText(target ? target.strategy.toUpperCase() : "AUTO TARGET", tx + 64, ty + 38);

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

    ctx.save();

    // Vignette + scanlines
    const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    grad.addColorStop(0, `rgba(40, 0, 12, ${0.5 * t})`);
    grad.addColorStop(1, `rgba(2, 4, 10, ${0.92 * t})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.globalAlpha = 0.18 * t;
    ctx.fillStyle = "#ff5b79";
    for (let y = 0; y < h; y += 4) {
      ctx.fillRect(0, y, w, 1);
    }
    ctx.globalAlpha = 1;

    // Glitch title (offset chromatic copies)
    ctx.textAlign = "center";
    const title = "SIGNAL LOST";
    const titleY = h / 2 - 30;
    const jitter = (Math.sin(elapsed * 12) * 2 + Math.sin(elapsed * 33) * 1.4) * t;
    ctx.font = "900 64px Inter, system-ui, sans-serif";
    ctx.fillStyle = `rgba(100, 217, 255, ${0.7 * t})`;
    ctx.fillText(title, w / 2 - 4 + jitter, titleY);
    ctx.fillStyle = `rgba(255, 91, 121, ${0.7 * t})`;
    ctx.fillText(title, w / 2 + 4 - jitter, titleY);
    ctx.fillStyle = `rgba(255, 248, 240, ${t})`;
    ctx.shadowColor = "rgba(255, 91, 121, 0.8)";
    ctx.shadowBlur = 24;
    ctx.fillText(title, w / 2, titleY);
    ctx.shadowBlur = 0;

    // Subtitle bar
    ctx.font = "800 12px Inter, system-ui, sans-serif";
    ctx.fillStyle = `rgba(255, 200, 87, ${t})`;
    ctx.fillText("// MISSION TERMINATED //", w / 2, titleY + 26);

    // Stats panel
    const pw = 480;
    const ph = 110;
    const px = w / 2 - pw / 2;
    const py = titleY + 50;
    ctx.globalAlpha = t;
    this.drawNeonPanel(px, py, pw, ph, "#ff5b79", 0.78, 14);

    const cells = [
      { label: "SURVIVED", value: formatTime(elapsed), color: "#64d9ff" },
      { label: "WAVE REACHED", value: String(snapshot.wave), color: "#b86cff" },
      { label: "FINAL LEVEL", value: String(snapshot.players?.[0]?.level ?? 1), color: "#ffd24a" },
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
        ctx.strokeStyle = "rgba(255, 91, 121, 0.3)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px + (i + 1) * cellW, py + 18);
        ctx.lineTo(px + (i + 1) * cellW, py + ph - 18);
        ctx.stroke();
      }
    });
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
  return String(Math.round(value));
}

function numericId(id) {
  return String(id)
    .split("")
    .reduce((total, char) => total + char.charCodeAt(0), 0);
}

function enemyDrawWidth(enemy) {
  if (enemy.type === "bruiser") return 62;
  if (enemy.type === "splitter") return 48;
  if (enemy.type === "shard") return 28;
  return 42;
}

function enemyDrawHeight(enemy) {
  if (enemy.type === "bruiser") return 68;
  if (enemy.type === "splitter") return 46;
  if (enemy.type === "shard") return 25;
  return 37;
}

function enemyFillColor(enemy) {
  if (enemy.type === "bruiser") return "#ab5cff";
  if (enemy.type === "splitter") return "#ff9a3d";
  if (enemy.type === "shard") return "#ffcf57";
  return "#ff5b79";
}

function enemyGlowColor(enemy) {
  if (enemy.eliteAffix === "armored") return "rgba(140, 245, 255, 0.28)";
  if (enemy.eliteAffix === "swift") return "rgba(255, 211, 92, 0.28)";
  if (enemy.type === "bruiser") return "rgba(184, 108, 255, 0.22)";
  if (enemy.type === "splitter" || enemy.type === "shard") return "rgba(255, 154, 61, 0.24)";
  return "rgba(255, 75, 111, 0.22)";
}

function enemyGlowRadius(enemy) {
  if (enemy.eliteAffix) return enemy.type === "bruiser" ? 92 : 66;
  if (enemy.type === "bruiser") return 76;
  if (enemy.type === "splitter") return 58;
  if (enemy.type === "shard") return 36;
  return 48;
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
