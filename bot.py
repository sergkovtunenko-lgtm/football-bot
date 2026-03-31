#!/usr/bin/env python3
"""
Telegram-бот для организации игры в манеже Пингвин.

Логика:
- Вторник 19:00 МСК — анонс, открытие записи
- Лимит 20 человек в основном составе (4 команды по 5)
- Остальные → резерв; если кто-то минусует — первый из резерва занимает место
- + / +1 / - — регистрация/отмена, после каждого действия обновлённый список
- «завершить» (только админ) — закрывает запись, случайно делит на команды,
  публикует топ-15 самых активных игроков по числу регистраций за всё время
- «1», «2», «3»... — фиксирует победу команды
- «итог» — таблица побед за вечер
"""

import os
import random
import logging
import sqlite3

import pytz
from dotenv import load_dotenv
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    filters,
    ContextTypes,
)

# ─── Конфигурация ────────────────────────────────────────────────────────────

load_dotenv()

BOT_TOKEN     = os.getenv("BOT_TOKEN", "")
GROUP_CHAT_ID = int(os.getenv("GROUP_CHAT_ID", "0"))
ADMIN_ID      = int(os.getenv("ADMIN_ID", "471691551"))
MOSCOW_TZ     = pytz.timezone("Europe/Moscow")
DB_PATH       = os.getenv("DB_PATH", "football.db")
MAX_PLAYERS   = 20   # лимит основного состава

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ─── База данных ─────────────────────────────────────────────────────────────

def init_db() -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS registrations (
                user_id          INTEGER PRIMARY KEY,
                username         TEXT,
                full_name        TEXT,
                has_guest        INTEGER DEFAULT 0,
                is_reserve       INTEGER DEFAULT 0,
                guest_is_reserve INTEGER DEFAULT 0,
                added_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS game_state (
                id           INTEGER PRIMARY KEY DEFAULT 1,
                is_open      INTEGER DEFAULT 0,
                teams_active INTEGER DEFAULT 0
            )
        """)
        conn.execute("INSERT OR IGNORE INTO game_state (id) VALUES (1)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS teams (
                team_number INTEGER,
                user_id     INTEGER,
                username    TEXT,
                full_name   TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS wins_tonight (
                user_id    INTEGER PRIMARY KEY,
                username   TEXT,
                full_name  TEXT,
                wins       INTEGER DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS all_time_stats (
                user_id   INTEGER PRIMARY KEY,
                username  TEXT,
                full_name TEXT,
                reg_count INTEGER DEFAULT 0
            )
        """)
        conn.commit()


def _get_state():
    with sqlite3.connect(DB_PATH) as conn:
        return conn.execute(
            "SELECT is_open, teams_active FROM game_state WHERE id=1"
        ).fetchone()


def _set_state(is_open=None, teams_active=None):
    with sqlite3.connect(DB_PATH) as conn:
        if is_open is not None and teams_active is not None:
            conn.execute("UPDATE game_state SET is_open=?, teams_active=? WHERE id=1",
                         (int(is_open), int(teams_active)))
        elif is_open is not None:
            conn.execute("UPDATE game_state SET is_open=? WHERE id=1", (int(is_open),))
        elif teams_active is not None:
            conn.execute("UPDATE game_state SET teams_active=? WHERE id=1", (int(teams_active),))
        conn.commit()


def _count_main() -> int:
    """Количество мест занято в основном составе."""
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT has_guest, guest_is_reserve FROM registrations WHERE is_reserve=0"
        ).fetchall()
    # Если гость в резерве (guest_is_reserve=1) — он не занимает место в основном
    return sum(1 + (hg if not gir else 0) for hg, gir in rows)


def _get_players(reserve: bool) -> list[tuple]:
    """reserve=False → основной состав, reserve=True → резерв."""
    with sqlite3.connect(DB_PATH) as conn:
        return conn.execute(
            "SELECT user_id, username, full_name, has_guest, guest_is_reserve "
            "FROM registrations WHERE is_reserve=? ORDER BY added_at",
            (int(reserve),)
        ).fetchall()


def _get_guests_in_reserve() -> list[tuple]:
    """Игроки в основном составе, чей гость сидит в резерве."""
    with sqlite3.connect(DB_PATH) as conn:
        return conn.execute(
            "SELECT user_id, username, full_name FROM registrations "
            "WHERE is_reserve=0 AND has_guest=1 AND guest_is_reserve=1 ORDER BY added_at"
        ).fetchall()


def _register(user_id, username, full_name, has_guest) -> str:
    """
    Регистрирует игрока.
    Возвращает: 'main' / 'main_guest_reserve' / 'reserve'
    """
    current_main = _count_main()

    # Вычитаем старые слоты этого игрока если уже зарегистрирован
    with sqlite3.connect(DB_PATH) as conn:
        existing = conn.execute(
            "SELECT is_reserve, has_guest, guest_is_reserve FROM registrations WHERE user_id=?",
            (user_id,)
        ).fetchone()

    is_new = existing is None

    if existing:
        old_is_res, old_hg, old_gir = existing
        if not old_is_res:
            current_main -= 1 + (old_hg if not old_gir else 0)

    free = MAX_PLAYERS - current_main

    if free <= 0:
        # Основной состав полон — оба в резерв
        is_reserve, guest_is_reserve = 1, 0
        result = 'reserve'
    elif has_guest and free == 1:
        # Ровно 1 место — человек в основной, гость в резерв
        is_reserve, guest_is_reserve = 0, 1
        result = 'main_guest_reserve'
    else:
        # Места есть для всех
        is_reserve, guest_is_reserve = 0, 0
        result = 'main'

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            INSERT INTO registrations
                (user_id, username, full_name, has_guest, is_reserve, guest_is_reserve, added_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET
                username=excluded.username, full_name=excluded.full_name,
                has_guest=excluded.has_guest, is_reserve=excluded.is_reserve,
                guest_is_reserve=excluded.guest_is_reserve
        """, (user_id, username, full_name, has_guest, is_reserve, guest_is_reserve))

        # Учитываем регистрацию в общей статистике (только новые, не обновления)
        if is_new:
            conn.execute("""
                INSERT INTO all_time_stats (user_id, username, full_name, reg_count)
                VALUES (?, ?, ?, 1)
                ON CONFLICT(user_id) DO UPDATE SET
                    username=excluded.username,
                    full_name=excluded.full_name,
                    reg_count = reg_count + 1
            """, (user_id, username, full_name))

        conn.commit()

    return result


def _unregister(user_id) -> tuple[bool, list[str]]:
    """Удаляет игрока. Возвращает (был_ли_в_списке, список_переведённых_из_резерва)."""
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT is_reserve, has_guest, guest_is_reserve FROM registrations WHERE user_id=?",
            (user_id,)
        ).fetchone()

    if not row:
        return False, []

    is_res, had_guest, guest_is_res = row
    # Считаем освобождённые места в основном составе
    if is_res:
        freed_slots = 0
    else:
        freed_slots = 1 + (had_guest if not guest_is_res else 0)

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM registrations WHERE user_id=?", (user_id,))
        conn.commit()

    promoted = []
    if freed_slots > 0:
        promoted = _promote_from_reserve(freed_slots)

    return True, promoted


def _promote_from_reserve(slots: int) -> list[str]:
    """Переводит игроков из резерва в основной состав пока есть свободные места."""
    promoted = []

    # Сначала продвигаем гостей, чьи «хозяева» уже в основном составе
    while slots > 0:
        guests_waiting = _get_guests_in_reserve()
        if not guests_waiting:
            break
        uid, uname, fname = guests_waiting[0]
        display = _display_name(uname, fname, uid)
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                "UPDATE registrations SET guest_is_reserve=0 WHERE user_id=?", (uid,)
            )
            conn.commit()
        slots -= 1
        promoted.append(f"гость ({display})")

    # Потом берём из полного резерва
    while slots > 0:
        with sqlite3.connect(DB_PATH) as conn:
            nxt = conn.execute(
                "SELECT user_id, username, full_name, has_guest FROM registrations "
                "WHERE is_reserve=1 ORDER BY added_at LIMIT 1"
            ).fetchone()
        if not nxt:
            break
        uid, uname, fname, has_guest = nxt
        display = _display_name(uname, fname, uid)

        if has_guest and slots >= 2:
            # Оба помещаются
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute(
                    "UPDATE registrations SET is_reserve=0, guest_is_reserve=0 WHERE user_id=?",
                    (uid,)
                )
                conn.commit()
            slots -= 2
            promoted.append(f"{display} + гость")
        elif has_guest and slots == 1:
            # Только сам, гость — в резерв гостей
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute(
                    "UPDATE registrations SET is_reserve=0, guest_is_reserve=1 WHERE user_id=?",
                    (uid,)
                )
                conn.commit()
            slots -= 1
            promoted.append(f"{display} (гость остаётся в резерве)")
        else:
            # Только сам, без гостя
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute(
                    "UPDATE registrations SET is_reserve=0 WHERE user_id=?", (uid,)
                )
                conn.commit()
            slots -= 1
            promoted.append(display)

    return promoted


def _clear_registrations():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM registrations")
        conn.execute("DELETE FROM teams")
        conn.execute("DELETE FROM wins_tonight")
        conn.commit()


# ─── Форматирование ──────────────────────────────────────────────────────────

def _display_name(username, full_name, user_id):
    if username:
        return f"@{username}"
    return full_name or f"id{user_id}"


def _build_player_list() -> str:
    main = _get_players(reserve=False)
    reserve = _get_players(reserve=True)

    lines = []
    n = 1
    total_main = _count_main()

    if main:
        lines.append(f"📋 *Основной состав ({total_main}/{MAX_PLAYERS}):*")
        for uid, uname, fname, has_guest, guest_is_res in main:
            name = _display_name(uname, fname, uid)
            lines.append(f"{n}. {name}")
            n += 1
            if has_guest and not guest_is_res:
                lines.append(f"{n}. гость ({name})")
                n += 1
            elif has_guest and guest_is_res:
                lines.append(f"  ↳ гость {name} — в резерве")

        full_teams = total_main // 5
        remainder = total_main % 5
        if full_teams > 0:
            word = "команда" if full_teams == 1 else "команды" if full_teams < 5 else "команд"
            lines.append(f"\n⚽ {full_teams} {word} по 5" +
                         (f" + {remainder} в запасе" if remainder else ""))
        else:
            lines.append(f"\n⚽ Нужно ещё {5 - total_main} до первой команды")
    else:
        lines.append("😔 Пока никто не записался.")

    # Резерв: сначала гости из основного, потом полные резервисты
    reserve_lines = []
    r_n = 1
    for uid, uname, fname, has_guest, _ in reserve:
        name = _display_name(uname, fname, uid)
        reserve_lines.append(f"{r_n}. {name}")
        r_n += 1
        if has_guest:
            reserve_lines.append(f"{r_n}. гость ({name})")
            r_n += 1

    if reserve_lines:
        lines.append(f"\n⏳ *Резерв ({r_n - 1} чел.):*")
        lines.extend(reserve_lines)

    lines.append("\n\n📌 *Запись:* напиши *+* (иду), *+1* (иду с другом) или *-* (не приду)")

    return "\n".join(lines)


def _build_top_players() -> str:
    """Топ-15 самых активных игроков по количеству регистраций за всё время."""
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT username, full_name, user_id, reg_count "
            "FROM all_time_stats ORDER BY reg_count DESC LIMIT 15"
        ).fetchall()
    if not rows:
        return "Пока нет данных."
    medals = ["🥇", "🥈", "🥉"]
    lines = []
    for i, (uname, fname, uid, count) in enumerate(rows):
        medal = medals[i] if i < 3 else f"{i+1}."
        name = _display_name(uname, fname, uid)
        word = "раз" if count == 1 else "раза" if count < 5 else "раз"
        lines.append(f"{medal} {name} — {count} {word}")
    return "\n".join(lines)


# ─── Команды ─────────────────────────────────────────────────────────────────

def _make_and_save_teams() -> list[list]:
    rows = _get_players(reserve=False)
    players = []
    for uid, uname, fname, has_guest, guest_is_res in rows:
        name = _display_name(uname, fname, uid)
        players.append((uid, uname, fname, name))
        if has_guest and not guest_is_res:
            players.append((None, None, f"гость ({name})", f"гость ({name})"))

    random.shuffle(players)
    teams = [players[i:i+5] for i in range(0, len(players), 5)]

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM teams")
        for team_num, members in enumerate(teams, start=1):
            for uid, uname, fname, display in members:
                conn.execute(
                    "INSERT INTO teams (team_number, user_id, username, full_name) VALUES (?,?,?,?)",
                    (team_num, uid, uname, display)
                )
        conn.commit()
    return teams


def _format_teams(teams: list[list]) -> str:
    lines = ["🎲 *Случайные команды:*\n"]
    for i, members in enumerate(teams, start=1):
        lines.append(f"*Команда {i}:*")
        for j, (_, _, _, display) in enumerate(members, start=1):
            lines.append(f"  {j}. {display}")
        lines.append("")
    lines.append("Результат игры: напиши номер победившей команды (*1*, *2*, *3*...)")
    return "\n".join(lines)


def _get_team_members(team_number: int) -> list[tuple]:
    with sqlite3.connect(DB_PATH) as conn:
        return conn.execute(
            "SELECT user_id, username, full_name FROM teams WHERE team_number=?",
            (team_number,)
        ).fetchall()


def _get_total_teams() -> int:
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute("SELECT MAX(team_number) FROM teams").fetchone()
    return row[0] or 0


def _record_win(team_number: int) -> list[str]:
    members = _get_team_members(team_number)
    names = []
    with sqlite3.connect(DB_PATH) as conn:
        for uid, uname, fname in members:
            if uid is None:
                continue
            display = _display_name(uname, fname, uid)
            names.append(display)
            conn.execute("""
                INSERT INTO wins_tonight (user_id, username, full_name, wins)
                VALUES (?, ?, ?, 1)
                ON CONFLICT(user_id) DO UPDATE SET wins = wins + 1
            """, (uid, uname, fname))
        conn.commit()
    return names


def _build_standings() -> str:
    """Таблица побед за вечер."""
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT username, full_name, user_id, wins FROM wins_tonight ORDER BY wins DESC"
        ).fetchall()
    if not rows:
        return "Пока нет результатов."
    medals = ["🥇", "🥈", "🥉"]
    lines = []
    for i, (uname, fname, uid, w) in enumerate(rows):
        medal = medals[i] if i < 3 else f"{i+1}."
        name = _display_name(uname, fname, uid)
        word = "победа" if w == 1 else "победы" if w < 5 else "побед"
        lines.append(f"{medal} {name} — {w} {word}")
    return "\n".join(lines)


# ─── Расписание ──────────────────────────────────────────────────────────────

async def job_announce(bot) -> None:
    _clear_registrations()
    _set_state(is_open=True, teams_active=False)
    text = (
        "⚽ *В пятницу в 21:00 — футбол в манеже Пингвин!*\n\n"
        "📌 *Как записаться — напиши в этот чат:*\n"
        "✅ *+*  — я иду\n"
        "✅ *+1* — иду и беру с собой друга (не из группы)\n"
        "❌ *-*  — не приду / отменить запись\n\n"
        f"👥 Основной состав — первые *{MAX_PLAYERS} человек*.\n"
        "Остальные попадают в резерв и автоматически переходят в основной состав, если кто-то отменяет запись.\n\n"
        "Команды делятся случайно по 5 человек перед игрой. Играем пятёрками 🏃"
    )
    await bot.send_message(chat_id=GROUP_CHAT_ID, text=text, parse_mode="Markdown")
    logger.info("Анонс опубликован.")


# ─── Handlers ────────────────────────────────────────────────────────────────

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "Привет! Я бот манежа Пингвин ⚽\n\n"
        "В чате пиши:\n"
        "*+* — записаться | *+1* — с другом | *-* — отмена\n"
        "*завершить* — закрыть запись _(только админ)_\n"
        "*1*, *2*... — победила эта команда\n"
        "*итог* — счёт за сегодня\n"
        "*/status* — текущий список",
        parse_mode="Markdown",
    )


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    state = _get_state()
    is_open = state[0] if state else False
    header = "📋 *Список участников:*\n\n" if is_open else "📋 *Список (запись закрыта):*\n\n"
    await update.message.reply_text(header + _build_player_list(), parse_mode="Markdown")


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message or not update.message.text:
        return

    raw = update.message.text.strip()
    raw_lower = raw.lower()
    user = update.message.from_user
    uid = user.id
    uname = user.username or ""
    fname = user.full_name or uname or f"id{uid}"
    display = _display_name(uname, fname, uid)

    state = _get_state()
    is_open, teams_active = (state[0], state[1]) if state else (False, False)

    # ── «завершить»
    if raw_lower == "завершить":
        is_admin = (uid == ADMIN_ID)
        if not is_admin:
            try:
                member = await context.bot.get_chat_member(GROUP_CHAT_ID, uid)
                is_admin = member.status in ("administrator", "creator")
            except Exception:
                pass
        if not is_admin:
            return

        if not is_open:
            await update.message.reply_text("Запись уже закрыта.")
            return

        _set_state(is_open=False, teams_active=True)
        main = _get_players(reserve=False)
        if not main:
            await update.message.reply_text("🔒 Запись закрыта. Никто не записался.")
            return

        final_text = "🔒 *Запись закрыта! Финальный список:*\n\n" + _build_player_list()
        final_text += "\n\n⏰ Встречаемся в *пятницу в 21:00* в манеже Пингвин! ⚽"
        await update.message.reply_text(final_text, parse_mode="Markdown")

        teams = _make_and_save_teams()
        await update.message.reply_text(_format_teams(teams), parse_mode="Markdown")

        top_text = "🌟 *Топ-15 самых активных игроков за всё время:*\n\n" + _build_top_players()
        await update.message.reply_text(top_text, parse_mode="Markdown")
        return

    # ── Номер победившей команды
    if raw.isdigit() and teams_active:
        team_num = int(raw)
        max_teams = _get_total_teams()
        if team_num < 1 or team_num > max_teams:
            await update.message.reply_text(f"Команд всего {max_teams}. Укажи число от 1 до {max_teams}.")
            return
        winners = _record_win(team_num)
        names_str = ", ".join(winners) if winners else "—"
        text = (
            f"✅ *Команда {team_num} победила!*\n_{names_str}_\n\n"
            f"🏆 *Счёт за вечер:*\n{_build_standings()}"
        )
        await update.message.reply_text(text, parse_mode="Markdown")
        return

    # ── «итог»
    if raw_lower == "итог":
        await update.message.reply_text(
            "🏆 *Счёт за сегодня:*\n\n" + _build_standings(),
            parse_mode="Markdown"
        )
        return

    # ── «+»
    if raw in ("+", "＋"):
        if not is_open:
            await update.message.reply_text("⏰ Запись сейчас закрыта.")
            return
        result = _register(uid, uname, fname, 0)
        if result == 'main':
            prefix = f"✅ {display} — в основном составе!"
        else:
            prefix = f"⏳ {display} — в резерве (основной состав заполнен)."
        await update.message.reply_text(prefix + "\n\n" + _build_player_list(), parse_mode="Markdown")
        return

    # ── «+1»
    if raw in ("+1", "+ 1", "＋1"):
        if not is_open:
            await update.message.reply_text("⏰ Запись сейчас закрыта.")
            return
        result = _register(uid, uname, fname, 1)
        if result == 'main':
            prefix = f"✅ {display} + гость — оба в основном составе!"
        elif result == 'main_guest_reserve':
            prefix = f"✅ {display} — в основном составе.\n⏳ Гость — в резерве (последнее место было одно)."
        else:
            prefix = f"⏳ {display} + гость — оба в резерве."
        await update.message.reply_text(prefix + "\n\n" + _build_player_list(), parse_mode="Markdown")
        return

    # ── «-»
    if raw == "-":
        if not is_open:
            await update.message.reply_text("⏰ Запись уже закрыта.")
            return
        was_in, promoted = _unregister(uid)
        if not was_in:
            await update.message.reply_text("Тебя не было в списке.")
            return
        text = f"❌ {display} удалён из списка."
        if promoted:
            names = ", ".join(promoted)
            text += f"\n\n🎉 Из резерва переходят в основной состав: {names}"
        text += "\n\n" + _build_player_list()
        await update.message.reply_text(text, parse_mode="Markdown")
        return


# ─── Точка входа ─────────────────────────────────────────────────────────────

def main() -> None:
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN не задан!")
    if not GROUP_CHAT_ID:
        raise RuntimeError("GROUP_CHAT_ID не задан!")

    init_db()

    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    scheduler = AsyncIOScheduler(timezone=MOSCOW_TZ)
    scheduler.add_job(
        job_announce,
        CronTrigger(day_of_week="tue", hour=19, minute=0, timezone=MOSCOW_TZ),
        args=[app.bot],
        id="announce",
    )
    scheduler.start()

    logger.info("Бот запущен. Ожидаю сообщения...")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
