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
      const color = pickup.type === "repair" ? "rgba(85, 214, 255, 0.42)" : "rgba(255, 200, 87, 0.36)";
      this.drawGlow(pickup.x, pickup.y, pickup.type === "repair" ? 58 : 42, color);
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
    const sprite = pickup.type === "repair" ? "shieldPickup" : "xpCrystal";
    const size = pickup.type === "repair" ? 34 : 24;
    const bob = Math.sin(elapsed * 5 + pickup.x * 0.03) * 4;
    const pulse = 1 + Math.sin(elapsed * 7 + pickup.y * 0.02) * 0.07;
    const rotation = pickup.type === "repair" ? Math.sin(elapsed * 2.5) * 0.08 : elapsed * 1.2;
    if (this.drawSprite(sprite, pickup.x, pickup.y + bob, size * pulse, size * pulse, rotation)) return;
    ctx.fillStyle = "#ffc857";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(pickup.x - pickup.radius, pickup.y - pickup.radius, pickup.radius * 2, pickup.radius * 2);
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
    if (effect.type !== "gravityWell") return;
    const progress = 1 - effect.ttl / effect.duration;
    const alpha = 1 - progress;
    const size = effect.radius * (0.55 + progress * 0.7);
    this.ctx.save();
    this.ctx.globalAlpha = alpha * 0.78;
    this.drawSprite("gravityWell", effect.x, effect.y, size, size);
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
      this.emitParticleBurst(pickup.x, pickup.y, 8 * dt, {
        baseVx: 0,
        baseVy: -18,
        spread: 32,
        size: pickup.type === "repair" ? 2.4 : 2,
        ttl: 0.8,
        color: pickup.type === "repair" ? "rgba(95, 222, 255, 0.58)" : "rgba(255, 207, 87, 0.58)",
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
    const pad = this.viewport.width < 520 ? 14 : 20;
    const hudWidth = Math.min(356, this.viewport.width - pad * 2);
    const barWidth = Math.max(150, hudWidth - 142);
    const hpAmount = player.hp / player.stats.maxHp;
    const xpAmount = player.xp / player.nextLevelXp;
    const dps = this.currentDps(snapshot.elapsed);
    this.peakDps = Math.max(this.peakDps * 0.998, dps, 50);
    ctx.save();
    this.drawPanel(pad, pad, hudWidth, 126);
    this.drawUiIcon("hull", pad + 25, pad + 31, 34, 34);
    this.drawUiIcon("xp", pad + 25, pad + 78, 30, 30);
    this.drawLabeledBar(pad + 52, pad + 22, barWidth, 14, hpAmount, "#ff4f73", "Hull", `${Math.ceil(player.hp)} / ${player.stats.maxHp}`);
    this.drawLabeledBar(pad + 52, pad + 68, barWidth, 10, xpAmount, "#57d8ff", "Core", `Lv ${player.level}`);
    ctx.font = "800 12px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#edf7ff";
    ctx.fillText("DPS", pad + 52, pad + 109);
    ctx.fillStyle = "#91a8bd";
    ctx.textAlign = "right";
    ctx.fillText(formatDamage(dps), pad + 52 + barWidth, pad + 109);
    ctx.textAlign = "left";
    drawBar(ctx, pad + 52, pad + 115, barWidth, 5, dps / this.peakDps, "#ffc857");

    this.drawPanel(pad, pad + 136, hudWidth, 48, 0.48);
    this.drawUiIcon("wave", pad + 28, pad + 160, 28, 28);
    this.drawUiIcon("timer", pad + 178, pad + 160, 27, 27);
    ctx.font = "800 15px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#edf7ff";
    ctx.fillText(`Wave ${snapshot.wave}`, pad + 52, pad + 166);
    ctx.fillText(formatTime(snapshot.elapsed), pad + 202, pad + 166);

    if (this.viewport.width >= 760) {
      const target = snapshot.targeting?.primaryWeapon;
      this.drawPanel(this.viewport.width - 268, pad, 248, 58, 0.44);
      this.drawUiIcon("target", this.viewport.width - 240, pad + 29, 30, 30);
      ctx.font = "800 13px Inter, system-ui, sans-serif";
      ctx.fillStyle = "#edf7ff";
      ctx.fillText(target ? target.strategy.toUpperCase() : "AUTO TARGET", this.viewport.width - 216, pad + 26);
      ctx.font = "700 12px Inter, system-ui, sans-serif";
      ctx.fillStyle = "#91a8bd";
      ctx.fillText(`${snapshot.enemies.length} contacts`, this.viewport.width - 216, pad + 44);
    }
    ctx.restore();
  }

  drawGameOver(snapshot) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = "rgba(2, 5, 12, 0.72)";
    ctx.fillRect(0, 0, this.viewport.width, this.viewport.height);
    this.drawPanel(this.viewport.width / 2 - 230, this.viewport.height / 2 - 110, 460, 190, 0.78);
    this.drawUiIcon("warning", this.viewport.width / 2, this.viewport.height / 2 - 78, 58, 50);
    ctx.fillStyle = "#edf7ff";
    ctx.textAlign = "center";
    ctx.font = "800 48px Inter, system-ui, sans-serif";
    ctx.fillText("Signal Lost", this.viewport.width / 2, this.viewport.height / 2 - 8);
    ctx.fillStyle = "#91a8bd";
    ctx.font = "700 18px Inter, system-ui, sans-serif";
    ctx.fillText(`Survived ${formatTime(snapshot.elapsed)} through wave ${snapshot.wave}`, this.viewport.width / 2, this.viewport.height / 2 + 38);
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
