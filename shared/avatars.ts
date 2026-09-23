export const avatarCategories = { business: "Делови", casual: "Ежедневни", creative: "Творчески" } as const;
export type LibraryAvatar = {
  id: string;
  name: string;
  description: string;
  category: keyof typeof avatarCategories;
  presentation: "female" | "male";
  imageUrl: string;
  active: boolean;
};
export const defaultAvatars = [
  { id: "mila", name: "Мила", description: "Топло присъствие в светло творческо студио.", category: "creative", presentation: "female" },
  { id: "boris", name: "Борис", description: "Непринуден водещ за истории и представяне на продукти.", category: "casual", presentation: "male" },
  { id: "elena", name: "Елена", description: "Уверено присъствие в модерен офис с гледка към София.", category: "business", presentation: "female" },
  { id: "daria", name: "Дария", description: "Свежо и непринудено присъствие за кратки реклами и социални мрежи.", category: "casual", presentation: "female" },
  { id: "alexander", name: "Александър", description: "Приятелски водещ в творческо пространство за идеи, технологии и продукти.", category: "creative", presentation: "male" },
  { id: "stefan", name: "Стефан", description: "Зрял и спокоен водещ за бизнес представяния и обяснителни видеа.", category: "business", presentation: "male" },
  { id: "yana", name: "Яна", description: "Топло присъствие в домашна обстановка за ежедневни истории и продукти.", category: "casual", presentation: "female" },
] as const;
