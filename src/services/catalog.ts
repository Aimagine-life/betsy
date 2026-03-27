export interface ServiceAction {
  name: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  description: string;
}

export interface ServiceDefinition {
  id: string;
  name: string;
  description: string;
  relayUrl: string;
  scopes: Record<string, string>;
  baseUrls: Record<string, string>;
  actions: Record<string, ServiceAction[]>;
}

const RELAY_URL = "https://auth.betsyai.io";

const services: ServiceDefinition[] = [
  {
    id: "google",
    name: "Google",
    description: "Почта, YouTube, Календарь, Диск, Контакты",
    relayUrl: RELAY_URL,
    scopes: { gmail: "Почта", youtube: "YouTube", calendar: "Календарь", drive: "Диск", contacts: "Контакты" },
    baseUrls: {
      gmail: "https://gmail.googleapis.com",
      youtube: "https://www.googleapis.com",
      calendar: "https://www.googleapis.com",
      drive: "https://www.googleapis.com",
      contacts: "https://people.googleapis.com",
    },
    actions: {
      gmail: [
        { name: "list_messages", method: "GET", path: "/gmail/v1/users/me/messages", description: "Получить список писем" },
        { name: "get_message", method: "GET", path: "/gmail/v1/users/me/messages/{id}?format=full", description: "Прочитать письмо по ID" },
        { name: "send_message", method: "POST", path: "/gmail/v1/users/me/messages/send", description: "Отправить письмо" },
        { name: "search_messages", method: "GET", path: "/gmail/v1/users/me/messages?q={query}", description: "Поиск писем" },
        { name: "list_labels", method: "GET", path: "/gmail/v1/users/me/labels", description: "Список папок/меток" },
        { name: "get_profile", method: "GET", path: "/gmail/v1/users/me/profile", description: "Профиль почты" },
      ],
      youtube: [
        { name: "search_videos", method: "GET", path: "/youtube/v3/search?part=snippet&type=video&q={query}", description: "Поиск видео" },
        { name: "get_video", method: "GET", path: "/youtube/v3/videos?part=snippet,statistics&id={id}", description: "Информация о видео" },
        { name: "my_channels", method: "GET", path: "/youtube/v3/channels?part=snippet,statistics&mine=true", description: "Мои каналы" },
        { name: "my_subscriptions", method: "GET", path: "/youtube/v3/subscriptions?part=snippet&mine=true", description: "Мои подписки" },
        { name: "my_playlists", method: "GET", path: "/youtube/v3/playlists?part=snippet&mine=true", description: "Мои плейлисты" },
      ],
      calendar: [
        { name: "list_events", method: "GET", path: "/calendar/v3/calendars/primary/events?timeMin={timeMin}&maxResults=10&singleEvents=true&orderBy=startTime", description: "Список событий" },
        { name: "create_event", method: "POST", path: "/calendar/v3/calendars/primary/events", description: "Создать событие" },
        { name: "delete_event", method: "DELETE", path: "/calendar/v3/calendars/primary/events/{eventId}", description: "Удалить событие" },
        { name: "list_calendars", method: "GET", path: "/calendar/v3/users/me/calendarList", description: "Список календарей" },
      ],
      drive: [
        { name: "list_files", method: "GET", path: "/drive/v3/files?pageSize=20&fields=files(id,name,mimeType,modifiedTime,size)", description: "Список файлов" },
        { name: "search_files", method: "GET", path: "/drive/v3/files?q=name contains '{query}'&fields=files(id,name,mimeType)", description: "Поиск файлов" },
        { name: "get_file", method: "GET", path: "/drive/v3/files/{fileId}?fields=id,name,mimeType,size,modifiedTime,webViewLink", description: "Информация о файле" },
      ],
      contacts: [
        { name: "list_contacts", method: "GET", path: "/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers&pageSize=50", description: "Список контактов" },
        { name: "search_contacts", method: "GET", path: "/v1/people:searchContacts?query={query}&readMask=names,emailAddresses,phoneNumbers", description: "Поиск контактов" },
      ],
    },
  },
  {
    id: "github",
    name: "GitHub",
    description: "Репозитории, Issues, Pull Requests",
    relayUrl: RELAY_URL,
    scopes: { default: "Полный доступ" },
    baseUrls: { default: "https://api.github.com" },
    actions: {
      default: [
        { name: "list_repos", method: "GET", path: "/user/repos?sort=updated&per_page=20", description: "Мои репозитории" },
        { name: "get_repo", method: "GET", path: "/repos/{owner}/{repo}", description: "Информация о репозитории" },
        { name: "list_issues", method: "GET", path: "/repos/{owner}/{repo}/issues?state=open", description: "Список Issues" },
        { name: "create_issue", method: "POST", path: "/repos/{owner}/{repo}/issues", description: "Создать Issue" },
        { name: "list_prs", method: "GET", path: "/repos/{owner}/{repo}/pulls?state=open", description: "Список Pull Requests" },
        { name: "get_user", method: "GET", path: "/user", description: "Мой профиль" },
        { name: "list_notifications", method: "GET", path: "/notifications", description: "Уведомления" },
      ],
    },
  },
  {
    id: "vk",
    name: "ВКонтакте",
    description: "Сообщения, стена, друзья, фото",
    relayUrl: RELAY_URL,
    scopes: { default: "Сообщения, стена, друзья, фото" },
    baseUrls: { default: "https://api.vk.com/method" },
    actions: {
      default: [
        { name: "get_profile", method: "GET", path: "/users.get?fields=photo_200,city,bdate&v=5.199", description: "Мой профиль" },
        { name: "get_friends", method: "GET", path: "/friends.get?fields=nickname,photo_100&v=5.199", description: "Список друзей" },
        { name: "get_dialogs", method: "GET", path: "/messages.getConversations?count=20&v=5.199", description: "Диалоги" },
        { name: "send_message", method: "POST", path: "/messages.send?random_id={random}&peer_id={peerId}&message={message}&v=5.199", description: "Отправить сообщение" },
        { name: "get_wall", method: "GET", path: "/wall.get?count=20&v=5.199", description: "Стена" },
        { name: "wall_post", method: "POST", path: "/wall.post?message={message}&v=5.199", description: "Пост на стену" },
      ],
    },
  },
  {
    id: "yandex",
    name: "Яндекс",
    description: "Почта, Диск",
    relayUrl: RELAY_URL,
    scopes: { mail: "Почта", disk: "Диск" },
    baseUrls: { mail: "https://mail.yandex.ru/api", disk: "https://cloud-api.yandex.net" },
    actions: {
      disk: [
        { name: "list_files", method: "GET", path: "/v1/disk/resources?path=/&limit=20", description: "Файлы на Яндекс.Диске" },
        { name: "get_disk_info", method: "GET", path: "/v1/disk/", description: "Информация о Диске" },
        { name: "search_files", method: "GET", path: "/v1/disk/resources/files?media_type={type}&limit=20", description: "Поиск файлов по типу" },
      ],
    },
  },
  {
    id: "reddit",
    name: "Reddit",
    description: "Лента, сабреддиты, профиль",
    relayUrl: RELAY_URL,
    scopes: { default: "Чтение, профиль, подписки" },
    baseUrls: { default: "https://oauth.reddit.com" },
    actions: {
      default: [
        { name: "me", method: "GET", path: "/api/v1/me", description: "Мой профиль" },
        { name: "hot", method: "GET", path: "/hot?limit=10", description: "Горячие посты" },
        { name: "subreddit_hot", method: "GET", path: "/r/{subreddit}/hot?limit=10", description: "Горячее в сабреддите" },
        { name: "my_subreddits", method: "GET", path: "/subreddits/mine/subscriber?limit=25", description: "Мои подписки" },
        { name: "search", method: "GET", path: "/search?q={query}&limit=10", description: "Поиск" },
      ],
    },
  },
  {
    id: "mailru",
    name: "Mail.ru",
    description: "Профиль, почта",
    relayUrl: RELAY_URL,
    scopes: { default: "Профиль, почта" },
    baseUrls: { default: "https://oauth.mail.ru" },
    actions: {
      default: [
        { name: "userinfo", method: "GET", path: "/userinfo", description: "Профиль пользователя" },
      ],
    },
  },
];

export function listServices(): ServiceDefinition[] {
  return services;
}

export function getService(id: string): ServiceDefinition | null {
  return services.find(s => s.id === id) ?? null;
}
