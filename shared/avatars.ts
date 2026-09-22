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
] as const;
