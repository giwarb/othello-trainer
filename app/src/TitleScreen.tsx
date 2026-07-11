import './TitleScreen.css'

/** タイトル画面の1モードカードに表示する情報。 */
export interface ModeCardInfo {
  key: string
  label: string
  description: string
}

interface TitleScreenProps {
  cards: ModeCardInfo[]
  onSelect: (key: string) => void
}

/**
 * アプリ起動時に最初に表示するタイトル/ホーム画面(T065)。
 * アプリ名・キャッチコピーと、各モードへの入り口となるカードを表示する。
 * カードをクリックすると`onSelect`にモードキーを渡し、呼び出し側(`App`)が
 * 該当モードへ遷移させる。
 */
export function TitleScreen({ cards, onSelect }: TitleScreenProps) {
  return (
    <section class="title-screen">
      <h1 class="title-screen__heading">オセロトレーナー</h1>
      <p class="title-screen__tagline">
        評価値と解説つきで、対局から定石・中盤・終盤・棋譜解析までを練習できるオセロ学習アプリです。
      </p>

      <div class="title-screen__cards">
        {cards.map((card) => (
          <button type="button" key={card.key} class="title-screen__card" onClick={() => onSelect(card.key)}>
            <span class="title-screen__card-label">{card.label}</span>
            <span class="title-screen__card-desc">{card.description}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
